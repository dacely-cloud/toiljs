import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { MemoryRef } from '../runtime/host.js';
import { DbFunctionKind } from '../db/types.js';

export interface ImageDevState {
    result: Buffer | null;
    calls: number;
}
export const freshImageState = (): ImageDevState => ({ result: null, calls: 0 });
export function resetImageState(state: ImageDevState): void {
    state.result?.fill(0);
    state.result = null;
    state.calls = 0;
}
const MAX_BYTES = 8 * 1024 * 1024;
function memory(ref: MemoryRef): Buffer {
    if (ref.memory === null) throw new Error('image: memory not bound');
    return Buffer.from(ref.memory.buffer);
}
export function buildImageImports(
    ref: MemoryRef,
    state: ImageDevState,
    kind: () => DbFunctionKind,
): Record<string, (...args: number[]) => number> {
    return {
        'image.process': (
            ptr: number,
            len: number,
            mode: number,
            width: number,
            height: number,
            quality: number,
        ): number => {
            state.result?.fill(0);
            state.result = null;
            if (
                ![DbFunctionKind.Action, DbFunctionKind.Job, DbFunctionKind.Derive].includes(kind())
            )
                return -9;
            if (state.calls++ !== 0) return -10;
            if (len < 0 || len > MAX_BYTES) return -4;
            if (
                mode < 0 ||
                mode > 2 ||
                quality < 1 ||
                quality > 100 ||
                (mode === 0 && (width !== 0 || height !== 0)) ||
                (mode !== 0 && (width < 1 || height < 1 || width > 4096 || height > 4096))
            )
                return -8;
            const mem = memory(ref);
            if (ptr < 0 || ptr > mem.length || len > mem.length - ptr)
                throw new Error('image.process: input out of bounds');
            const header = Buffer.alloc(24);
            header[0] = 1;
            header[1] = mode;
            header[2] = quality;
            header.writeUInt32LE(width, 4);
            header.writeUInt32LE(height, 8);
            header.writeUInt32LE(len, 20);
            const result = spawnSync(
                process.execPath,
                [
                    '--no-warnings',
                    '--max-old-space-size=128',
                    fileURLToPath(new URL('./worker.mjs', import.meta.url)),
                ],
                {
                    input: Buffer.concat([header, mem.subarray(ptr, ptr + len)]),
                    timeout: 5000,
                    maxBuffer: MAX_BYTES + 19,
                    stdio: ['pipe', 'pipe', 'ignore'],
                },
            );
            if (result.error !== undefined)
                return 'code' in result.error && result.error.code === 'ETIMEDOUT' ? -6 : -7;
            const bytes = result.stdout;
            if (result.status !== 0 || bytes.length < 4 || bytes.length > MAX_BYTES + 18) return -7;
            const status = bytes.readInt32LE();
            if (status < 0) return status;
            const frame = bytes.subarray(4);
            if (
                status !== 0 ||
                frame.length < 14 ||
                frame[0] !== 1 ||
                ![1, 2].includes(frame[9]) ||
                frame.readUInt32LE(10) !== frame.length - 14
            )
                return -7;
            state.result = Buffer.from(frame);
            return frame.length;
        },
        'image.take_result': (ptr: number, cap: number): number => {
            const result = state.result ?? Buffer.alloc(0),
                mem = memory(ref);
            if (
                ptr < 0 ||
                cap < 0 ||
                ptr > mem.length ||
                Math.min(cap, result.length) > mem.length - ptr
            )
                throw new Error('image.take_result: output out of bounds');
            if (cap < result.length) return -1;
            result.copy(mem, ptr);
            result.fill(0);
            state.result = null;
            return result.length;
        },
    };
}

import type { MemoryRef } from '../runtime/host.js';

export interface DaemonHttpRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: Uint8Array;
}
export interface DaemonHttpResponse {
    readonly status: number;
    readonly headers?: readonly (readonly [string, string])[];
    readonly body?: Uint8Array;
}
/** Synchronous deterministic transport seam. No network request is made by the emulator. */
export type DaemonHttpMock = (request: DaemonHttpRequest) => DaemonHttpResponse | null;
const FAILED = -BigInt(0x10000 + 0x0405);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function mockDaemonHttp(
    ref: MemoryRef,
    mock: DaemonHttpMock | undefined,
    reqPtr: number,
    reqLen: number,
    outPtr: number,
    outCap: number,
): bigint {
    if (!ref.memory) throw new Error('daemon.http_call: memory is not bound');
    const memory = Buffer.from(ref.memory.buffer);
    if (
        [reqPtr, reqLen, outPtr, outCap].some((n) => !Number.isInteger(n) || n < 0) ||
        reqPtr > memory.length ||
        reqLen > memory.length - reqPtr ||
        outPtr > memory.length ||
        outCap > memory.length - outPtr
    )
        throw new Error('daemon.http_call: invalid memory range');
    if (reqLen > 256 * 1024) throw new Error('daemon.http_call: request over cap');
    if (!mock) return FAILED;
    const request = Buffer.from(memory.subarray(reqPtr, reqPtr + reqLen));
    let offset = 0;
    const take = (length: number): Buffer => {
        if (length < 0 || length > request.length - offset) throw new Error('malformed request');
        const result = request.subarray(offset, offset + length);
        offset += length;
        return result;
    };
    const u16 = (): number => take(2).readUInt16LE();
    const str16 = (cap: number): string => {
        const size = u16();
        if (size > cap) throw new Error('field over cap');
        return UTF8.decode(take(size));
    };
    let input: DaemonHttpRequest;
    try {
        const methodLength = take(1)[0];
        if (methodLength === 0 || methodLength > 16) return FAILED;
        const method = UTF8.decode(take(methodLength));
        const url = str16(8192);
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return FAILED;
        const count = u16();
        if (count > 64) return FAILED;
        const headers: [string, string][] = [];
        for (let i = 0; i < count; i++) headers.push([str16(8192), str16(8192)]);
        const length = take(4).readUInt32LE();
        if (length > 256 * 1024) return FAILED;
        input = { method, url, headers, body: Uint8Array.from(take(length)) };
        if (offset !== request.length) return FAILED;
    } catch {
        return FAILED;
    }
    const response = mock(input);
    if (response === null) return FAILED;
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
        return FAILED;
    const headers = response.headers ?? [];
    if (headers.length > 64) return FAILED;
    const head = Buffer.alloc(4);
    head.writeUInt16LE(response.status);
    head.writeUInt16LE(headers.length, 2);
    const fields: Buffer[] = [head];
    for (const pair of headers) {
        for (const value of pair) {
            const bytes = Buffer.from(value, 'utf8');
            if (bytes.length > 8192) return FAILED;
            const length = Buffer.alloc(2);
            length.writeUInt16LE(bytes.length);
            fields.push(length, bytes);
        }
    }
    const body = Buffer.from(response.body ?? []).subarray(0, 1024 * 1024);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    fields.push(length, body);
    const encoded = Buffer.concat(fields);
    if (encoded.length > outCap) return -1n;
    encoded.copy(memory, outPtr);
    return BigInt(encoded.length);
}

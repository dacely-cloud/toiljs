// Runs the AssemblyScript specs in test/assembly/*.spec.ts by compiling each with toilscript and
// executing its `_start` (which runs the describe/it bodies + the shim's asserts). A failed assert
// aborts; this runner surfaces it as a vitest failure. Runs them via toilscript, no external runner.
import { describe, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TOILSCRIPT_BIN = join(here, '..', 'node_modules', 'toilscript', 'bin', 'toilscript.js');
const SPECS = ['example', 'cookie', 'ssr'] as const;

function liftString(ptr: number, mem: WebAssembly.Memory): string {
    if (!ptr) return '(no message)';
    const u32 = new Uint32Array(mem.buffer);
    const len = (u32[(ptr - 4) >>> 2] >>> 1) >>> 0;
    const u16 = new Uint16Array(mem.buffer);
    let s = '';
    const start = ptr >>> 1;
    for (let i = 0; i < len; i++) s += String.fromCharCode(u16[start + i]);
    return s;
}

describe('assembly specs (toilscript-compiled)', () => {
    for (const spec of SPECS) {
        it(`${spec}.spec.ts passes`, async () => {
            const tmp = mkdtempSync(join(tmpdir(), 'toiljs-asm-'));
            try {
                const src = join(here, 'assembly', `${spec}.spec.ts`);
                const out = join(tmp, `${spec}.wasm`);
                const r = spawnSync(
                    'node',
                    [TOILSCRIPT_BIN, src, '-o', out, '--exportStart', '_start', '--runtime', 'stub'],
                    { encoding: 'utf8' },
                );
                if (r.status !== 0) {
                    throw new Error(`toilscript compile ${spec}.spec.ts failed:\n${r.stderr}${r.stdout}`);
                }
                const wasm = readFileSync(out);
                const holder: { mem: WebAssembly.Memory | null } = { mem: null };
                const { instance } = await WebAssembly.instantiate(wasm, {
                    env: {
                        abort(msg: number, _file: number, line: number): void {
                            const m = holder.mem ? liftString(msg >>> 0, holder.mem) : '';
                            throw new Error(`${spec}.spec.ts assertion failed: "${m}" (line ${line})`);
                        },
                        seed: () => 0,
                    },
                });
                holder.mem = instance.exports.memory as WebAssembly.Memory;
                (instance.exports._start as () => void)();
            } finally {
                rmSync(tmp, { recursive: true, force: true });
            }
        });
    }
});

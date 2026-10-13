import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { buildHostImports, freshDispatchState } from '../src/devserver/runtime/host.js';
import { buildDaemonImports, freshDaemonState } from '../src/devserver/daemon/host.js';
import { envelopeWindowOf } from '../src/devserver/wasm/envelope-window.js';
import { TOIL_SERVER_ENV_DTS } from '../src/compiler/generate.js';

describe('reported framework regressions', () => {
    it('preserves a large upload through the real toiljs decoder and allocator', () => {
        const root = mkdtempSync(join(tmpdir(), 'toil-upload-'));
        try {
            const source = join(root, 'app.ts');
            const artifact = join(root, 'app.wasm');
            const runtime = relative(root, resolve('server/runtime')).replace(/\\/g, '/');
            writeFileSync(
                source,
                `
import { Server } from '${runtime}/env/Server';
import { ToilHandler } from '${runtime}/handlers/ToilHandler';
import { Request } from '${runtime}/request';
import { Response } from '${runtime}/response';
class Echo extends ToilHandler {
  handle(request: Request): Response { return Response.bytes(request.body); }
}
Server.handler = (): ToilHandler => new Echo();
export { handle } from '${runtime}/exports/index';
`,
            );
            const compiled = spawnSync(
                process.execPath,
                [
                    resolve('node_modules/toilscript/bin/toilscript.js'),
                    source,
                    '-o',
                    artifact,
                    '--runtime',
                    'stub',
                    '--memoryBase',
                    '65536',
                ],
                { encoding: 'utf8' },
            );
            expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
            const module = new WasmServerModule(artifact);
            module.refresh();
            const body = Uint8Array.from({ length: 512 * 1024 }, (_, i) => i % 251);
            const result = module.dispatch({ method: 'POST', path: '/upload', headers: [], body });
            expect(result.body.length).toBe(body.length);
            expect(Buffer.from(result.body).equals(Buffer.from(body))).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('declares session revocation for application typechecking', () => {
        expect(TOIL_SERVER_ENV_DTS).toContain(
            'function revokeUserSessions(userData: Uint8Array): void;',
        );
    });

    it.each([1024, 65536, 262144])(
        'delivers requests safely across the compiled request window (%i bytes)',
        (memoryBase) => {
            const root = mkdtempSync(join(tmpdir(), 'toil-window-'));
            try {
                const source = join(root, 'app.ts');
                const wasm = join(root, 'app.wasm');
                writeFileSync(
                    source,
                    `
export function handle(ofs: i32, len: i32): i64 {
  const body = new Uint8Array(8); body[0] = 200;
  return (<i64>body.dataStart << 32) | 8;
}
export function render(ofs: i32, len: i32): i64 { return handle(ofs, len); }
`,
                );
                const compiled = spawnSync(
                    process.execPath,
                    [
                        resolve('node_modules/toilscript/bin/toilscript.js'),
                        source,
                        '-o',
                        wasm,
                        '--runtime',
                        'stub',
                        '--memoryBase',
                        String(memoryBase),
                    ],
                    { encoding: 'utf8' },
                );
                expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
                const window = envelopeWindowOf(readFileSync(wasm))!;
                expect(window).toBeGreaterThanOrEqual(memoryBase);
                const module = new WasmServerModule(wasm);
                module.refresh();
                const request = {
                    method: 'POST',
                    path: '/',
                    headers: [],
                    body: new Uint8Array(window - 10),
                };
                expect(module.dispatch(request).status).toBe(200);
                request.body = new Uint8Array(window);
                expect(module.dispatch(request).status).toBe(200);
                expect(module.dispatchRender(request).length).toBe(8);
                request.body = new Uint8Array(8 * 1024 * 1024);
                expect(() => module.dispatch(request)).toThrow(/8 MiB request limit/);
                expect(() => module.dispatchRender(request)).toThrow(/8 MiB request limit/);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it('fails closed for malformed data sections and permits modules without active data', () => {
        const magic = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
        expect(envelopeWindowOf(magic)).toBeNull();
        expect(
            envelopeWindowOf(Buffer.concat([magic, Buffer.from([11, 4, 1, 1, 1, 65])])),
        ).toBeNull();
        for (const data of [
            [11, 4, 1, 0, 65],
            [11, 4, 1, 0, 35, 0],
            [11, 3, 1, 3, 0],
        ]) {
            expect(() => envelopeWindowOf(Buffer.concat([magic, Buffer.from(data)]))).toThrow();
        }
    });

    it.each(['request', 'daemon'])(
        'provides bounded server logging on the %s surface',
        (surface) => {
            const memory = new WebAssembly.Memory({ initial: 1 });
            new Uint8Array(memory.buffer).set(new TextEncoder().encode('héllo'));
            const state = surface === 'request' ? freshDispatchState() : freshDaemonState();
            const imports =
                surface === 'request'
                    ? buildHostImports({ memory }, state as ReturnType<typeof freshDispatchState>)
                    : buildDaemonImports({ memory }, state, {
                          isLeader: () => true,
                          epoch: () => 1n,
                          taskCount: () => 0,
                          nextFireMs: () => null,
                      });
            const log = (imports.env as Record<string, (...args: number[]) => number>).server_log;
            const info = vi.spyOn(console, 'info').mockImplementation(() => {});
            try {
                expect(log(0, 0, 6)).toBe(1);
                expect(info).toHaveBeenCalledWith('[toil guest]', 'héllo');
                for (let i = 1; i < 32; i++) expect(log(0, 0, 6)).toBe(1);
                expect(log(0, 0, 6)).toBe(0);
                for (const args of [
                    [3, 0, 6],
                    [0, 0, 4097],
                    [0, 65536, 1],
                ])
                    expect(() => log(...args)).toThrow();
            } finally {
                info.mockRestore();
            }
        },
    );
});

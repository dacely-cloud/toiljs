import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { WasmServerModule } from '../src/devserver/runtime/module';
import { DEFAULT_CSP } from '../src/shared/security';

it('emits browser security defaults through the compiled native response envelope', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-native-security-'));
    try {
        const runtime = path.relative(root, path.resolve('server/runtime')).replace(/\\/g, '/');
        fs.writeFileSync(
            path.join(root, 'app.ts'),
            `
import { Server } from '${runtime}/env/Server';
import { ToilHandler } from '${runtime}/handlers/ToilHandler';
import { Request } from '${runtime}/request';
import { Response } from '${runtime}/response';
class Echo extends ToilHandler {
 handle(req: Request): Response {
   const response = Response.bytes(req.body);
   if (req.path == '/custom') {
      response.setHeader('Content-Security-Policy', "default-src 'none'");
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
   }
   return response;
 }
}
Server.handler = (): ToilHandler => new Echo();
export { handle } from '${runtime}/exports/index';
`,
        );
        const wasm = path.join(root, 'app.wasm');
        const compile = spawnSync(
            process.execPath,
            [
                path.resolve('node_modules/toilscript/bin/toilscript.js'),
                path.join(root, 'app.ts'),
                '-o',
                wasm,
                '--runtime',
                'stub',
                '--memoryBase',
                '65536',
            ],
            { encoding: 'utf8' },
        );
        expect(compile.status, compile.stdout + compile.stderr).toBe(0);
        const module = new WasmServerModule(wasm);
        module.refresh();
        const body = Uint8Array.from({ length: 128 * 1024 }, (_, i) => i % 251);
        const response = module.dispatch({ method: 'POST', path: '/', headers: [], body });
        expect(response.headers).toContainEqual(['content-security-policy', DEFAULT_CSP]);
        expect(response.headers).toContainEqual(['cross-origin-opener-policy', 'same-origin']);
        expect(
            response.headers.some(([name]) => name.toLowerCase() === 'strict-transport-security'),
        ).toBe(false);
        expect(Buffer.from(response.body).equals(Buffer.from(body))).toBe(true);
        const custom = module.dispatch({ method: 'POST', path: '/custom', headers: [], body });
        expect(
            custom.headers.filter(([name]) => name.toLowerCase() === 'content-security-policy'),
        ).toEqual([['Content-Security-Policy', "default-src 'none'"]]);
        expect(
            custom.headers.filter(([name]) => name.toLowerCase() === 'cross-origin-opener-policy'),
        ).toEqual([['Cross-Origin-Opener-Policy', 'same-origin-allow-popups']]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

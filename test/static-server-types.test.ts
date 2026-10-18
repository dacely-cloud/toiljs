import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { buildHostImports, freshDispatchState } from '../src/devserver/runtime/host.js';

it('typechecks server imports and all globals in a fresh tree without generated declarations', () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-static-types-'));
    try {
        mkdirSync(join(root, 'node_modules'));
        symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
        symlinkSync(
            process.env.TOILSCRIPT_TEST_BIN
                ? dirname(dirname(process.env.TOILSCRIPT_TEST_BIN))
                : resolve('node_modules/toilscript'),
            join(root, 'node_modules/toilscript'),
        );
        writeFileSync(
            join(root, 'main.ts'),
            `
import { Response } from 'toiljs/server/runtime';
export function me(): Response {
    const user = AuthService.getUser();
    const env = Environment.get('PUBLIC_BASE_URL');
    if (user != null) { const id: Uint8Array = user.toilUserId; return Response.text(user.username + id.length.toString()); }
    if (false) {
        EmailService.sendDetached('a@example.com', 'subject', 'body');
        TwoFactor.issue('a@example.com', 'test');
        RateLimitService.guard(1, 0, 5, 60);
        AuthService.revokeSession();
        AuthService.revokeUserSessions(new Uint8Array(0));
        AuthService.deleteUser(ToilUserId.fromBytes(new Uint8Array(32)));
        AuthService.indexUsers(8, null);
        Response.empty(204).setCookie(Cookie.create('test', 'value'));
    }
    return Response.text(user == null ? 'anonymous' : env ?? 'signed in');
}
`,
        );
        writeFileSync(
            join(root, 'tsconfig.json'),
            JSON.stringify({
                extends: join(root, 'node_modules/toilscript/std/assembly.json'),
                compilerOptions: { noEmit: true, skipLibCheck: true },
                include: ['main.ts'],
            }),
        );
        const result = spawnSync(
            process.execPath,
            [
                resolve('node_modules/typescript/bin/tsc'),
                '--noEmit',
                '-p',
                join(root, 'tsconfig.json'),
            ],
            { encoding: 'utf8' },
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it('compiles and decodes the built-in principal without a generated user entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-default-user-'));
    try {
        mkdirSync(join(root, 'node_modules'));
        symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
        const app = join(root, 'app.ts'),
            out = join(root, 'app.wasm');
        writeFileSync(
            app,
            `
import { DataWriter } from 'data';
export function anonymous():bool { return AuthService.getUser()==null; }
export function invalid():void { __toilDecodeAuthUser(new DataWriter().writeU32(1).writeBytes(new Uint8Array(16)).writeString('Ada').toBytes()); }
export function decoded():bool {
  const id=new Uint8Array(32);id[31]=7;
  const bytes=new DataWriter().writeU32(0xaabbccdd).writeBytes(id).writeString('Ada').toBytes();
  const user=__toilDecodeAuthUser(bytes);
  return user.username=='Ada' && user.toilUserId.length==32 && user.toilUserId[31]==7;
}
`,
        );
        const result = spawnSync(
            process.execPath,
            [
                process.env.TOILSCRIPT_TEST_BIN ??
                    resolve('node_modules/toilscript/bin/toilscript.js'),
                app,
                '-o',
                out,
                '--runtime',
                'stub',
                '--memoryBase',
                '65536',
                '--lib',
                relative(root, resolve('server/globals')),
            ],
            { cwd: root, encoding: 'utf8' },
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const ref = { memory: null as WebAssembly.Memory | null };
        const instance = new WebAssembly.Instance(
            new WebAssembly.Module(readFileSync(out)),
            buildHostImports(ref, freshDispatchState()),
        );
        ref.memory = instance.exports.memory as WebAssembly.Memory;
        expect((instance.exports.anonymous as () => number)()).toBe(1);
        expect((instance.exports.decoded as () => number)()).toBe(1);
        expect(() => (instance.exports.invalid as () => void)()).toThrow(
            /Invalid session identity/,
        );
        writeFileSync(
            app,
            `
@user class Custom { toilUserId:Uint8Array=new Uint8Array(32);username:string='Ada';role:i32=7; }
export function decoded():bool {
  const user=__toilDecodeAuthUser(new Custom().encode());
  return user.role==7 && user.username=='Ada';
}
`,
        );
        const custom = spawnSync(
            process.execPath,
            [
                process.env.TOILSCRIPT_TEST_BIN ??
                    resolve('node_modules/toilscript/bin/toilscript.js'),
                app,
                '-o',
                out,
                '--runtime',
                'stub',
                '--memoryBase',
                '65536',
                '--lib',
                relative(root, resolve('server/globals')),
            ],
            { cwd: root, encoding: 'utf8' },
        );
        expect(custom.status, custom.stdout + custom.stderr).toBe(0);
        const customRef = { memory: null as WebAssembly.Memory | null };
        const customInstance = new WebAssembly.Instance(
            new WebAssembly.Module(readFileSync(out)),
            buildHostImports(customRef, freshDispatchState()),
        );
        customRef.memory = customInstance.exports.memory as WebAssembly.Memory;
        expect((customInstance.exports.decoded as () => number)()).toBe(1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

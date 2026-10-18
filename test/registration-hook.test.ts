import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { __resetDbForTests, devDb } from '../src/devserver/db/index.js';
import { clearEnvCache } from '../src/devserver/config/dotenv.js';
import { __resetRatelimitForTests } from '../src/devserver/config/ratelimit.js';
import { Auth, SERVER_KEM_PUBLIC_KEY } from '../src/client/auth.js';
import { DataReader } from '../src/io/codec.js';

const root = mkdtempSync(join(tmpdir(), 'toil-registration-hook-'));
const out = join(root, 'app.wasm');
let module: WasmServerModule;
beforeAll(() => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
    mkdirSync(join(root, 'lib'));
    writeFileSync(
        join(root, 'lib/emails.ts'),
        'export namespace AuthEmail { export function confirm(a:string,b:string):void {} export function reset(a:string,b:string):void {} export function twofa(a:string,b:string,c:string,d:string):void {} }',
    );
    writeFileSync(
        join(root, 'app.ts'),
        `
import { Server, RestHandler, ToilHandler } from 'toiljs/server/runtime';
@data class ProfileKey { id:Uint8Array=new Uint8Array(0); constructor(id:Uint8Array=new Uint8Array(0)){this.id=id;} }
@data class Profile { username:string=''; email:string=''; }
@database class Profiles { @collection static profiles:Documents<ProfileKey,Profile>; }
AuthService.onRegistered((id:ToilUserId,username:string,email:string):void=>{
  const profile=new Profile();profile.username=username;profile.email=email;
  Profiles.profiles.compareExchange(new ProfileKey(id.toBytes()),null,profile);
  if(Environment.get('TEST_REGISTRATION_FAIL')=='1')throw new Error('initializer interrupted');
});
Server.handler=():ToilHandler=>new RestHandler();
export * from 'toiljs/server/runtime/exports';
`,
    );
    const result = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ?? resolve('node_modules/toilscript/bin/toilscript.js'),
            'app.ts',
            resolve('server/auth/AuthController.ts'),
            resolve('server/auth/AuthStore.ts'),
            resolve('server/auth/AuthMaintenance.ts'),
            resolve('server/auth/AuthUser.ts'),
            resolve('server/auth/AuthStateDb.ts'),
            '-o',
            out,
            '--authUser',
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
            '--lib',
            `${relative(root, resolve('server/globals'))},lib`,
        ],
        { cwd: root, encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
}, 30000);
beforeEach(() => {
    __resetDbForTests();
    __resetRatelimitForTests();
    clearEnvCache();
    module = new WasmServerModule(out);
    module.refresh();
    vi.stubEnv('TOIL_DEV_CHECK_DB_LIMITS', '1');
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        const response = module.dispatch({
            method: init?.method ?? 'GET',
            path: url.pathname,
            headers: [['host', 'localhost']],
            body: init?.body ? new Uint8Array(init.body as ArrayBuffer) : new Uint8Array(0),
        });
        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            arrayBuffer: async () => Uint8Array.from(response.body).buffer,
            text: async () => Buffer.from(response.body).toString('utf8'),
        };
    });
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearEnvCache();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
it('initializes a registered identity before activation and resumes an interrupted idempotent hook', async () => {
    vi.stubEnv('TEST_REGISTRATION_FAIL', '1');
    clearEnvCache();
    await expect(
        Auth.register('hookuser', 'original-password-A1', 'hook@example.com'),
    ).rejects.toThrow(/initializer interrupted/);
    const store = (devDb as unknown as { store: Map<string, Buffer> }).store;
    const profiles = () =>
        [...store.entries()].filter(([key]) => key.startsWith('Profiles/profiles\0'));
    expect(profiles()).toHaveLength(1);
    const bytes = new DataReader(profiles()[0][1]);
    bytes.readU32();
    expect(bytes.readString()).toBe('hookuser');
    expect(bytes.readString()).toBe('hook@example.com');
    await expect(
        Auth.login('hookuser', 'original-password-A1', {
            serverKemPublicKey: SERVER_KEM_PUBLIC_KEY,
        }),
    ).rejects.toThrow();
    vi.stubEnv('TEST_REGISTRATION_FAIL', '0');
    clearEnvCache();
    __resetRatelimitForTests();
    await Auth.register('hookuser', 'original-password-A1', 'hook@example.com');
    expect(profiles()).toHaveLength(1);
    expect(
        await Auth.login('hookuser', 'original-password-A1', {
            serverKemPublicKey: SERVER_KEM_PUBLIC_KEY,
        }),
    ).toBeTruthy();
}, 60000);

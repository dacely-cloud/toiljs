import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { DaemonHost } from '../src/devserver/daemon/index.js';
import { __resetDbForTests, devDb } from '../src/devserver/db/index.js';
import { __resetRatelimitForTests } from '../src/devserver/config/ratelimit.js';
import { clearEnvCache } from '../src/devserver/config/dotenv.js';
import { Auth, SERVER_KEM_PUBLIC_KEY } from '../src/client/auth.js';
import { DataReader } from '../src/io/codec.js';

const root = mkdtempSync(join(tmpdir(), 'toil-auth-maintenance-'));
let hot: WasmServerModule;
let cold: DaemonHost;
let cookies: string[] = [];
const shared = `
@data class StateKey {}
@data class State { id:Uint8Array=new Uint8Array(0); result:bool=false; cursor:Uint8Array=new Uint8Array(0); }
@database class TestState { @collection static state:Documents<StateKey,State>; }
`;
function compile(name: string, source: string, entries: string[], mode: string) {
    writeFileSync(join(root, name + '.ts'), shared + source);
    const result = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ?? resolve('node_modules/toilscript/bin/toilscript.js'),
            name + '.ts',
            ...entries.map((name) => resolve('server/auth/' + name + '.ts')),
            '-o',
            join(root, name + '.wasm'),
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
            '--targetMode',
            mode,
            '--lib',
            `${relative(root, resolve('server/globals'))},lib`,
            ...(mode === 'hot' ? ['--authUser'] : []),
        ],
        { cwd: root, encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
}
beforeAll(() => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
    mkdirSync(join(root, 'lib'));
    writeFileSync(
        join(root, 'lib/emails.ts'),
        'export namespace AuthEmail { export function confirm(a:string,b:string):void {} export function reset(a:string,b:string):void {} export function twofa(a:string,b:string,c:string,d:string):void {} }',
    );
    const common = ['AuthStore', 'AuthMaintenance', 'AuthStateDb', 'SessionEpochs'];
    compile(
        'hot',
        `
import { Server, RestHandler, ToilHandler, Response, RouteContext } from 'toiljs/server/runtime';
AuthService.onRegistered((id:ToilUserId,username:string,email:string):void=>{
  const state=new State(); state.id=id.toBytes(); TestState.state.upsert(new StateKey(),state);
});
@rest('test') class Tests {
 @post('/cookie') cookie(ctx:RouteContext):Response {
   const state=TestState.state.require(new StateKey());
   const response=Response.text('test session');
   response.setCookie(AuthService.mintSession(__toilEncodeAuthUser(state.id,'cleanupuser')));
   return response;
 }
 @post('/delete') remove(ctx:RouteContext):Response {
   const state=TestState.state.require(new StateKey());
   return Response.text(AuthService.deleteUser(ToilUserId.fromBytes(state.id))?'yes':'no');
 }
}
Server.handler=():ToilHandler=>new RestHandler();
export * from 'toiljs/server/runtime/exports';
`,
        [...common, 'AuthUser', 'AuthController'],
        'hot',
    );
    compile(
        'cold',
        `
import { AuthDb, Username } from 'toiljs/server/auth/AuthStore';
import { AuthStateDb, SessionUserKey, SessionEpochKey, SessionEpoch, FactorKey, FactorRevision, FactorSettings, TotpCounter } from 'toiljs/server/auth/AuthStateDb';
import { base64UrlEncode } from 'toiljs/server/runtime';
@daemon class Cleanup {
 @scheduled('1h') @job seed():void {
   const state=TestState.state.require(new StateKey());
   const account=AuthDb.accounts.require(new Username('localhost','cleanupuser'));
   const name=account.username+'\\x00'+crypto.toHex(account.accountId);
   const epochId='3:localhost\\x00'+crypto.toHex(state.id);
   for(let i:i32=1;i<=24;i++) {
     const secret=new Uint8Array(48); secret.fill(<u8>i);
     const epoch=new SessionEpoch(); epoch.revision=<u64>i;
     epoch.factorHost='localhost'; epoch.factorName=name; epoch.factorMethod=2;
     epoch.factorRevision=<u64>i; epoch.factorSecret=secret;
     AuthStateDb.epochRevisions.claim(new SessionEpochKey(epochId,<u64>i),epoch);
     AuthStateDb.epochHeads.upsert(new SessionUserKey(epochId),epoch);
     const factor=new FactorSettings(); factor.method=2; factor.revision=<u64>i; factor.encryptedSecret=secret;
     AuthStateDb.factorRevisions.claim(new FactorRevision('localhost',name,<u64>i),factor);
     AuthStateDb.factorHeads.upsert(new FactorKey('localhost',name),factor);
     AuthStateDb.totpCounters.upsert(new FactorKey('localhost',base64UrlEncode(secret.subarray(12,44))),new TotpCounter());
   }
 }

 @scheduled('1h') @job remove():void {
   const state=TestState.state.require(new StateKey());
   state.result=AuthService.deleteUser(ToilUserId.fromBytes(state.id));
   TestState.state.upsert(new StateKey(),state);
 }
 @scheduled('1h') @job backfill():void {
   const state=TestState.state.require(new StateKey());
   const next=AuthService.indexUsers(1,state.cursor.length==0?null:state.cursor);
   state.cursor=next==null?new Uint8Array(0):next;
   TestState.state.upsert(new StateKey(),state);
 }
}
`,
        common,
        'cold',
    );
}, 30000);
const request = (path: string, cookie = '') =>
    hot.dispatch({
        method: path === '/auth/me' ? 'GET' : 'POST',
        path,
        headers: [
            ['host', 'localhost'],
            ...(cookie ? [['cookie', cookie] as [string, string]] : []),
        ],
        body: new Uint8Array(),
    });
beforeEach(() => {
    __resetDbForTests();
    __resetRatelimitForTests();
    clearEnvCache();
    cookies = [];
    vi.stubEnv('TOIL_DEV_CHECK_DB_LIMITS', '1');
    hot = new WasmServerModule(join(root, 'hot.wasm'));
    hot.refresh();
    cold = new DaemonHost(
        join(root, 'cold.wasm'),
        {
            region: null,
            standbyRegion: null,
            defaultIntervalMs: 3600000,
            tickBudgetMs: 30000,
            gasTick: 0,
            maxTasks: 64,
        },
        'all',
        () => {},
    );
    cold.refresh();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const response = hot.dispatch({
            method: init?.method ?? 'GET',
            path: new URL(String(input), 'http://localhost').pathname,
            headers: [['host', 'localhost']],
            body: init?.body ? new Uint8Array(init.body as ArrayBuffer) : new Uint8Array(),
        });
        for (const [name, value] of response.headers)
            if (name.toLowerCase() === 'set-cookie') cookies.push(value.split(';')[0]);
        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            arrayBuffer: async () => Uint8Array.from(response.body).buffer,
            text: async () => Buffer.from(response.body).toString(),
        };
    });
});
afterEach(() => {
    cold?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearEnvCache();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const run = (name: string) =>
    cold.runTask(cold.tasks.find((task) => task.name.endsWith(name))!.name, Date.now());
const store = () => (devDb as unknown as { store: Map<string, Buffer> }).store;
const accounts = () =>
    [...store().entries()].filter(([key]) => key.startsWith('AuthDb/accounts\0'));
const result = () => {
    const bytes = [...store().entries()].find(([key]) => key.startsWith('TestState/state\0'))![1];
    const reader = new DataReader(bytes);
    reader.readU32();
    reader.readBytes();
    return reader.readU8() === 1;
};
it('deletes by stable id from a real cold Job, revokes sessions, and permits a new registration', async () => {
    await Auth.register('cleanupuser', 'Original-password-A1', 'cleanup@example.com');
    const login = await Auth.login('cleanupuser', 'Original-password-A1', {
        serverKemPublicKey: SERVER_KEM_PUBLIC_KEY,
    });
    expect(login).toBeTruthy();
    expect(accounts()).toHaveLength(1);
    const session = cookies.join('; ');
    expect(request('/auth/me', session).status).toBe(200);
    const state = [...store().entries()].find(([key]) => key.startsWith('TestState/state\0'))!;
    const oldState = Buffer.from(state[1]);
    expect(run('remove')).toMatchObject({ status: 'ok' });
    expect(result()).toBe(true);
    expect(accounts()).toHaveLength(0);
    expect(
        [...store().keys()].filter((key) => key.startsWith('AuthDb/userAccounts\0')),
    ).toHaveLength(0);
    expect(request('/auth/me', session).status).toBe(401);
    expect(run('remove')).toMatchObject({ status: 'ok' });
    expect(result()).toBe(false);
    __resetRatelimitForTests();
    await expect(
        Auth.login('cleanupuser', 'Original-password-A1', {
            serverKemPublicKey: SERVER_KEM_PUBLIC_KEY,
        }),
    ).rejects.toThrow();
    await Auth.register('cleanupuser', 'Different-password-B2', 'cleanup@example.com');
    expect(accounts()).toHaveLength(1);
    store().set(state[0], oldState); // A delayed job still holds the previous id.
    expect(run('remove')).toMatchObject({ status: 'ok' });
    expect(result()).toBe(false);
    expect(accounts()).toHaveLength(1);
}, 60000);
it('rejects request Actions before changing an account', async () => {
    await Auth.register('actionuser', 'Original-password-A1', 'action@example.com');
    expect(() => request('/test/delete')).toThrow(/requires a Job/);
    expect(accounts()).toHaveLength(1);
}, 60000);
it('rebuilds a missing identity index in bounded background pages', async () => {
    await Auth.register('backfilluser', 'Original-password-A1', 'backfill@example.com');
    for (const key of store().keys())
        if (key.startsWith('AuthDb/userAccounts\0')) store().delete(key);
    expect(run('remove')).toMatchObject({ status: 'ok' });
    expect(result()).toBe(false);
    let indexed = false;
    for (let i = 0; i < 100; i++) {
        expect(run('backfill')).toMatchObject({ status: 'ok' });
        if ([...store().keys()].some((key) => key.startsWith('AuthDb/userAccounts\0'))) {
            indexed = true;
            break;
        }
    }
    expect(indexed).toBe(true);
    expect(run('remove')).toMatchObject({ status: 'ok' });
    expect(result()).toBe(true);
}, 60000);
it('resumes deletion after a cleanup trap without re-enabling the marked account', async () => {
    await Auth.register('retryuser', 'Original-password-A1', 'retry@example.com');
    vi.spyOn(devDb, 'getDelete').mockImplementationOnce(() => {
        throw new Error('cleanup interrupted');
    });
    expect(run('remove')).toMatchObject({
        status: 'trapped',
        error: expect.stringContaining('cleanup interrupted'),
    });
    expect(accounts()).toHaveLength(1);
    await expect(
        Auth.login('retryuser', 'Original-password-A1', {
            serverKemPublicKey: SERVER_KEM_PUBLIC_KEY,
        }),
    ).rejects.toThrow();
    expect(run('remove')).toMatchObject({ status: 'ok' });
    expect(result()).toBe(true);
    expect(accounts()).toHaveLength(0);
}, 60000);

function expectErasedFactors() {
    for (const collection of ['factorHeads', 'factorRevisions', 'totpCounters'])
        expect(
            [...store().keys()].filter((key) => key.startsWith('AuthStateDb/' + collection + '\0')),
        ).toHaveLength(0);
    const epochs = [...store().entries()].filter(([key]) =>
        /^AuthStateDb\/epoch(?:Heads|Revisions)\0/.test(key),
    );
    expect(epochs.length).toBeGreaterThan(0);
    for (const [, bytes] of epochs) {
        const reader = new DataReader(bytes);
        reader.readU32();
        reader.readU64();
        reader.readBytes();
        expect(reader.readString()).toBe('');
        expect(reader.readString()).toBe('');
        expect(reader.readU8()).toBe(0);
        expect(reader.readU64()).toBe(0n);
        expect(reader.readBytes()).toHaveLength(0);
    }
}
it('erases every historical sealed factor and replay counter from a deletion Job', async () => {
    await Auth.register('cleanupuser', 'Original-password-A1', 'cleanup@example.com');
    expect(run('seed')).toMatchObject({ status: 'ok' });
    expect(
        [...store().keys()].filter((key) => key.startsWith('AuthStateDb/totpCounters\0')),
    ).toHaveLength(24);
    // Old stored epochs predate the appended deletion-fence fields. Their raw
    // owner bytes must be used for release, including after a restart.
    for (const [key, bytes] of store())
        if (
            key.startsWith('AuthStateDb/epochRevisions\0') ||
            key.startsWith('AuthStateDb/epochHeads\0')
        )
            store().set(key, bytes.subarray(0, bytes.length - 17));
    expect(run('remove')).toMatchObject({ status: 'ok' });
    expect(result()).toBe(true);
    expectErasedFactors();
    await Auth.register('cleanupuser', 'Original-password-A1', 'cleanup@example.com');
    await expect(
        Auth.login('cleanupuser', 'Original-password-A1', {
            serverKemPublicKey: SERVER_KEM_PUBLIC_KEY,
        }),
    ).resolves.toBeTruthy();
});
it('resumes bounded HTTP factor erasure with the original deletion session only', async () => {
    await Auth.register('cleanupuser', 'Original-password-A1', 'cleanup@example.com');
    expect(run('seed')).toMatchObject({ status: 'ok' });
    const session = request('/test/cookie')
        .headers.find(([name]) => name.toLowerCase() === 'set-cookie')![1]
        .split(';')[0];
    expect(request('/auth/me', session).status).toBe(200);
    let complete = false;
    let retries = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const response = request('/auth/delete', session);
            expect(response.status).toBe(200);
            complete = true;
            break;
        } catch (error) {
            expect(String(error)).toMatch(/cleanup incomplete/);
            retries++;
            expect(request('/auth/me', session).status).toBe(401);
        }
    }
    expect(complete).toBe(true);
    expect(retries).toBeGreaterThan(0);
    expectErasedFactors();
    await Auth.register('cleanupuser', 'Original-password-A1', 'cleanup@example.com');
    await Auth.login('cleanupuser', 'Original-password-A1', {
        serverKemPublicKey: SERVER_KEM_PUBLIC_KEY,
    });
    expect(request('/auth/delete', session).status).toBe(401);
    expect(accounts()).toHaveLength(1);
});

it('keeps already-erased revision claims occupied when cleanup resumes after a crash', async () => {
    await Auth.register('cleanupuser', 'Original-password-A1', 'cleanup@example.com');
    expect(run('seed')).toMatchObject({ status: 'ok' });
    const session = request('/test/cookie')
        .headers.find(([name]) => name.toLowerCase() === 'set-cookie')![1]
        .split(';')[0];
    const releases = vi.spyOn(devDb, 'uniqueRelease');
    let claims = 0;
    await expect(
        hot.dispatchAsync(
            {
                method: 'POST',
                path: '/auth/delete',
                headers: [
                    ['host', 'localhost'],
                    ['cookie', session],
                ],
                body: new Uint8Array(),
            },
            {
                afterDatabaseOperation(point) {
                    if (
                        point.collection === 'AuthStateDb/epochRevisions' &&
                        point.operation === 'data.unique_claim' &&
                        ++claims === 2
                    )
                        throw new Error('crash after erasing a revision');
                },
            },
        ),
    ).rejects.toThrow('crash after erasing a revision');
    expect(run('remove')).toMatchObject({ status: 'ok' });
    expect(result()).toBe(true);
    expectErasedFactors();
    expect(
        releases.mock.calls.filter(
            ([, state, handle]) => state.handles[handle]?.name === 'AuthStateDb/epochRevisions',
        ),
    ).toHaveLength(24);
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { devDb, __resetDbForTests } from '../src/devserver/db/index.js';
import { WasmServerModule } from '../src/devserver/runtime/module.js';

const root = mkdtempSync(join(tmpdir(), 'toil-session-state-'));
let module: WasmServerModule;
const store = (devDb as unknown as { store: Map<string, Buffer> }).store;
// @data's u32 boundary precedes revision; appended ownership bytes follow it.
const EPOCH_REVISION_OFFSET = 4;
const fnv = (s: string): string => {
    let n = 0x811c9dc5;
    for (const c of s) n = Math.imul(n ^ c.charCodeAt(0), 0x01000193) >>> 0;
    return String(n);
};
function dispatch(path: string, cookie = '', secure = false, rpc?: string) {
    return module.dispatch({
        method: ['/session/me', '/session/budget', '/session/overbudget'].includes(path)
            ? 'GET'
            : 'POST',
        path,
        headers: [
            ['host', 'localhost'],
            ['cookie', cookie],
            ['x-forwarded-proto', secure ? 'https' : 'http'],
            ...(rpc ? [['dacely-rpc', fnv(rpc)] as [string, string]] : []),
        ],
        body: new Uint8Array(0),
    });
}
function mint(secure = false): string {
    const response = dispatch('/session/mint', '', secure);
    expect(response.status).toBe(204);
    return response.headers
        .filter(([name]) => name.toLowerCase() === 'set-cookie')
        .map(([, value]) => value.split(';')[0])
        .join('; ');
}
function seedChain(length: number): string {
    expect(dispatch('/session/revoke').status).toBe(204);
    const [headKey] = [...store.keys()].filter((key) => key.startsWith('AuthStateDb/epochHeads\0'));
    const [claimKey, value] = [...store.entries()].find(([key]) =>
        key.startsWith('AuthStateDb/epochRevisions\0'),
    )!;
    const key = Buffer.from(claimKey.slice(claimKey.indexOf('\0') + 1), 'latin1');
    for (let revision = 1; revision <= length; revision++) {
        const k = Buffer.from(key);
        const v = Buffer.from(value);
        k.writeBigUInt64LE(BigInt(revision), k.length - 8);
        v.writeBigUInt64LE(BigInt(revision), EPOCH_REVISION_OFFSET);
        store.set('AuthStateDb/epochRevisions\0' + k.toString('latin1'), v);
    }
    store.delete(headKey);
    return headKey;
}
function revision(headKey: string): bigint {
    const value = store.get(headKey)!;
    return value.readBigUInt64LE(EPOCH_REVISION_OFFSET);
}

beforeAll(() => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
    writeFileSync(
        join(root, 'app.ts'),
        `
import { DataWriter } from 'data';
import { AuthStateDb, SessionDigest } from 'toiljs/server/auth/AuthStateDb';
import { Server, Request, Response, Rest, ToilHandler } from 'toiljs/server/runtime';
function user(): Uint8Array {
    const w = new DataWriter(); w.writeU32(1); w.writeBytes(new Uint8Array(32).fill(7)); return w.toBytes();
}
@rest('session') class Session {
    @post('/mint') mint(): Response { return Response.empty(204).setCookie(AuthService.mintSession(user())).setCookie(AuthService.userCookie(user())); }
    @post('/revoke') revoke(): Response { AuthService.revokeUserSessions(user()); return Response.empty(204); }
    @auth @get('/me') me(): Response { AuthService.hasSession(); return Response.text('ok'); }
    @auth @get('/budget') budget(): Response { return this.reads(61); }
    @auth @get('/overbudget') overbudget(): Response { return this.reads(62); }
    private reads(count: i32): Response {
        for (let i = 0; i < count; i++) AuthStateDb.revokedSessions.lookup(new SessionDigest('missing'));
        return Response.text('ok');
    }
}
@auth @service class Secret { @remote value(): i32 { return 7; } }
@auth @remote export function privateValue(): i32 { return 8; }
class Handler extends ToilHandler {
    handle(req: Request): Response { const hit = Rest.dispatch(req); return hit == null ? Response.unhandled() : hit; }
}
Server.handler = (): ToilHandler => new Handler();
export * from 'toiljs/server/runtime/exports';
`,
    );
    const compiler =
        process.env.TOILSCRIPT_TEST_BIN ?? resolve('node_modules/toilscript/bin/toilscript.js');
    const result = spawnSync(
        process.execPath,
        [
            compiler,
            'app.ts',
            resolve('server/auth/AuthStateDb.ts'),
            '-o',
            'app.wasm',
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
    expect(readFileSync(join(root, 'app.wasm')).length).toBeGreaterThan(0);
}, 30000);
beforeEach(() => {
    __resetDbForTests();
    module = new WasmServerModule(join(root, 'app.wasm'));
    module.refresh();
    vi.stubEnv('TOIL_DEV_CHECK_DB_LIMITS', '1');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('compiled session security under native operation limits', () => {
    it('charges the three auth reads once per request and shares the handler budget', () => {
        const cookie = mint();
        const get = vi.spyOn(devDb, 'get');
        const lookup = vi.spyOn(devDb, 'uniqueLookup');
        expect(dispatch('/session/me', cookie).status).toBe(200);
        expect(get).toHaveBeenCalledTimes(1);
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('leaves exactly 61 reads for a signed-in handler under the 64-operation budget', () => {
        const cookie = mint();
        expect(dispatch('/session/budget', cookie).status).toBe(200);
        expect(() => dispatch('/session/overbudget', cookie)).toThrow(/TDL020/);
    });

    it('repairs a short stale head on a writable read and keeps queries read-only', () => {
        const cookie = mint();
        const head = seedChain(3);
        expect(dispatch('/session/me', cookie).status).toBe(401);
        expect(store.has(head)).toBe(false);
        mint();
        expect(revision(head)).toBe(3n);
        const lookup = vi.spyOn(devDb, 'uniqueLookup');
        mint();
        expect(lookup).toHaveBeenCalledTimes(1);
    });

    it('recovers a chain longer than 64 revisions in bounded, persistent chunks', () => {
        const cookie = mint();
        const head = seedChain(70);
        expect(() => dispatch('/session/me', cookie)).toThrow(/recovering/);
        expect(store.has(head)).toBe(false);
        for (let attempt = 1; attempt <= 8; attempt++) {
            const lookup = vi.spyOn(devDb, 'uniqueLookup');
            expect(() => mint()).toThrow(/recovering/);
            expect(lookup).toHaveBeenCalledTimes(8);
            expect(revision(head)).toBe(BigInt(attempt * 8));
            lookup.mockRestore();
        }
        const fresh = mint();
        expect(revision(head)).toBe(70n);
        expect(dispatch('/session/me', fresh).status).toBe(200);
        expect(dispatch('/session/me', cookie).status).toBe(401);
        expect(dispatch('/session/revoke').status).toBe(204);
        expect(dispatch('/session/me', fresh).status).toBe(401);
    });

    it('can revoke again after recovering more than 64 orphaned claims', () => {
        const head = seedChain(70);
        for (let attempt = 1; attempt <= 8; attempt++) {
            expect(() => dispatch('/session/revoke')).toThrow(/recovering/);
            expect(revision(head)).toBe(BigInt(attempt * 8));
        }
        expect(dispatch('/session/revoke').status).toBe(204);
        expect(revision(head)).toBe(71n);
        expect(dispatch('/session/me', mint()).status).toBe(200);
    });

    it('preserves a revocation claim when its head write fails and repairs it on retry', () => {
        const cookie = mint();
        vi.spyOn(devDb, 'compareExchange').mockImplementationOnce(() => {
            throw new Error('head write failed');
        });
        expect(() => dispatch('/session/revoke')).toThrow(/head write failed/);
        expect(dispatch('/session/me', cookie).status).toBe(401);
        expect(dispatch('/session/me', mint()).status).toBe(200);
    });

    it('does not move a head backward when a revocation write was delayed', () => {
        const head = seedChain(1);
        mint(); // Repair to generation 1 before the next revocation.
        const original = devDb.compareExchange.bind(devDb);
        vi.spyOn(devDb, 'compareExchange').mockImplementationOnce((...args) => {
            const [claimKey, value] = [...store.entries()].find(([key]) =>
                key.startsWith('AuthStateDb/epochRevisions\0'),
            )!;
            const key = Buffer.from(claimKey.slice(claimKey.indexOf('\0') + 1), 'latin1');
            const newer = Buffer.from(value);
            key.writeBigUInt64LE(3n, key.length - 8);
            newer.writeBigUInt64LE(3n, EPOCH_REVISION_OFFSET);
            store.set('AuthStateDb/epochRevisions\0' + key.toString('latin1'), newer);
            store.set(head, newer);
            return original(...args);
        });
        expect(dispatch('/session/revoke').status).toBe(204);
        expect(revision(head)).toBe(3n);
    });

    it('does not overwrite a head advanced while a repair was delayed', () => {
        const head = seedChain(3);
        const original = devDb.compareExchange.bind(devDb);
        vi.spyOn(devDb, 'compareExchange').mockImplementationOnce((...args) => {
            const newer = Buffer.from(
                [...store.entries()].find(([key]) =>
                    key.startsWith('AuthStateDb/epochRevisions\0'),
                )![1],
            );
            newer.writeBigUInt64LE(4n, EPOCH_REVISION_OFFSET);
            store.set(head, newer);
            return original(...args);
        });
        mint();
        expect(revision(head)).toBe(4n);
    });

    // Guard code is emitted by toilscript. Set TOILSCRIPT_TEST_BIN to the
    // matching compiler checkout to exercise this cross-repository change;
    // the compiler's own test:auth-guards suite always checks all guard forms.
    it.skipIf(!process.env.TOILSCRIPT_TEST_BIN).each([false, true])(
        'clears both cookies on REST and both RPC guard forms (HTTPS=%s)',
        (secure) => {
            const cookie = mint(secure);
            expect(dispatch('/session/revoke', '', secure).status).toBe(204);
            for (const [path, rpc] of [
                ['/session/me', undefined],
                ['/__toil_rpc', 'Secret.value'],
                ['/__toil_rpc', 'privateValue'],
            ] as const) {
                const response = dispatch(path, cookie, secure, rpc);
                expect(response.status).toBe(401);
                const cookies = response.headers
                    .filter(([name]) => name.toLowerCase() === 'set-cookie')
                    .map(([, value]) => value);
                expect(cookies).toHaveLength(2);
                expect(cookies[0]).toMatch(secure ? /^__Host-toil_sess=/ : /^toil_sess=/);
                expect(cookies[1]).toMatch(secure ? /^__Secure-toil_user=/ : /^toil_user=/);
                for (const value of cookies) {
                    expect(value).toMatch(/Max-Age=0(?:;|$)/);
                    expect(value).toMatch(/Path=\/(?:;|$)/);
                    if (secure) expect(value).toMatch(/; Secure(?:;|$)/);
                }
            }
        },
    );

    it('fails closed on a head read error without clearing valid browser credentials', () => {
        const cookie = mint();
        vi.spyOn(devDb, 'get').mockReturnValueOnce(-1031);
        expect(() => dispatch('/session/me', cookie)).toThrow(/unavailable|status/i);
    });
});

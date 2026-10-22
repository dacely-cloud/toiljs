import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBuiltServer } from '../src/devserver/production.js';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { prepareGoogleKeys, verifyGoogleToken } from '../src/devserver/runtime/google.js';
import { installDevBlobEnvironment } from '../src/devserver/config/env.js';
import { __resetDbForTests, devDb } from '../src/devserver/db/index.js';
import { __resetRatelimitForTests } from '../src/devserver/config/ratelimit.js';
import { clearEnvCache } from '../src/devserver/config/dotenv.js';
import { Auth, TwoFactorRequiredError } from '../src/client/auth.js';
import { DataReader, DataWriter } from '../src/io/codec.js';

const realFetch = globalThis.fetch;
const root = mkdtempSync(join(tmpdir(), 'toil-google-'));
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid: 'test-google',
    alg: 'RS256',
    use: 'sig',
};
const now = Math.floor(Date.now() / 30000) * 30000 + 5000;
let module: WasmServerModule;
let restoreEnvironment: () => void;
let jar: Map<string, string>;
let host: string;
let lastHeaders: readonly (readonly [string, string])[];
function jwt(
    nonce: string,
    overrides: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
) {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-google', ...header })).toString(
        'base64url',
    );
    const p = Buffer.from(
        JSON.stringify({
            iss: 'https://accounts.google.com',
            aud: 'test-client',
            sub: '12345',
            email: 'google@example.com',
            email_verified: true,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce,
            ...overrides,
        }),
    ).toString('base64url');
    return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), pair.privateKey).toString('base64url')}`;
}
function totp(secret: string, at = Date.now()) {
    let bits = '';
    for (const c of secret)
        bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
    const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
    const digest = createHmac('sha1', key).update(counter).digest();
    return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000)
        .toString()
        .padStart(6, '0');
}
async function dispatch(
    path: string,
    body = new Uint8Array(),
    method = 'POST',
    cookieOverride?: string,
) {
    const result = await module.dispatchWithNetwork({
        method,
        path,
        headers: [
            ['host', host],
            ['cookie', cookieOverride ?? [...jar].map(([k, v]) => `${k}=${v}`).join('; ')],
        ],
        body,
    });
    lastHeaders = result.headers;
    for (const [name, value] of result.headers)
        if (name.toLowerCase() === 'set-cookie') {
            const [key, ...valueParts] = value.split(';')[0].split('=');
            if (/Max-Age=0(?:;|$)/.test(value)) jar.delete(key);
            else jar.set(key, valueParts.join('='));
        }
    return result;
}
beforeAll(async () => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
    mkdirSync(join(root, 'lib'));
    writeFileSync(
        join(root, 'lib/emails.ts'),
        'export namespace AuthEmail { export function confirm(a:string,b:string):void {} export function reset(a:string,b:string):void {} export function twofa(a:string,b:string,c:string,d:string):void {} }',
    );
    writeFileSync(
        join(root, 'main.ts'),
        `
import { Server, RestHandler, ToilHandler, Response, RouteContext } from 'toiljs/server/runtime';
import { Authenticator } from 'toiljs/server/auth/Authenticator';
import { AuthStateDb, SessionUserKey, SessionEpoch } from 'toiljs/server/auth/AuthStateDb';
@rest('vectors') class Vectors {
 @auth @post('/revoke-verified') revoke(ctx:RouteContext):Response { AuthService.__revokeVerifiedSessions(); return Response.text('ok'); }
 @auth @post('/legacy-head') legacy(ctx:RouteContext):Response {
  const epoch=new SessionEpoch(); epoch.revision=999;
  AuthStateDb.epochHeads.upsert(new SessionUserKey(crypto.toHex(AuthService.getUser()!.toilUserId)),epoch);
  return Response.text('ok');
 }
 @get('/totp') vector(ctx:RouteContext):Response {
  const secret=Uint8Array.wrap(String.UTF8.encode('12345678901234567890'));
  return Response.text(Authenticator.code(secret,1));
 }
}
Server.handler=():ToilHandler=>new RestHandler(); export * from 'toiljs/server/runtime/exports';
`,
    );
    const entries = [
        'AuthStore',
        'AuthMaintenance',
        'AuthStateDb',
        'SessionEpochs',
        'AuthUser',
        'AuthController',
    ];
    const build = spawnSync(
        process.execPath,
        [
            resolve('node_modules/toilscript/bin/toilscript.js'),
            'main.ts',
            ...entries.map((e) => resolve(`server/auth/${e}.ts`)),
            '-o',
            join(root, 'main.wasm'),
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
            '--targetMode',
            'hot',
            '--lib',
            `${relative(root, resolve('server/globals'))},lib`,
            '--authUser',
        ],
        { cwd: root, encoding: 'utf8' },
    );
    expect(build.status, build.stdout + build.stderr).toBe(0);
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ keys: [jwk] }), {
                headers: { 'cache-control': 'max-age=3600' },
            }),
        ),
    );
    await prepareGoogleKeys();
    vi.unstubAllGlobals();
}, 30000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    clearEnvCache();
    __resetDbForTests();
    __resetRatelimitForTests();
    restoreEnvironment = installDevBlobEnvironment({
        vars: new Map([['AUTH_GOOGLE_CLIENT_ID', 'test-client']]),
        secrets: new Map([['AUTH_SESSION_SECRET', 'a'.repeat(64)]]),
    });
    jar = new Map();
    host = 'localhost';
    lastHeaders = [];
    module = new WasmServerModule(join(root, 'main.wasm'));
    module.refresh();
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        if (String(input).startsWith('https:'))
            return new Response(JSON.stringify({ keys: [jwk] }), {
                headers: { 'cache-control': 'max-age=3600' },
            });
        if (String(input).startsWith('http:')) return realFetch(input, init);
        const result = await dispatch(
            String(input),
            init?.body ? new Uint8Array(init.body as ArrayBuffer) : new Uint8Array(),
            init?.method ?? 'GET',
        );
        return new Response(result.body as BodyInit, { status: result.status });
    });
});
afterEach(() => {
    restoreEnvironment();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearEnvCache();
});

async function googleLogin() {
    const start = await Auth.googleLoginStart();
    const token = jwt(start.nonce);
    return Auth.loginWithGoogle(token);
}

describe('Google signature verification', () => {
    it('verifies RSA signature and required claims', () => {
        expect(verifyGoogleToken(jwt('nonce'), 'test-client', 'nonce')?.sub).toBe('12345');
        for (const claims of [
            { aud: 'other' },
            { iss: 'https://evil.test' },
            { azp: 'other' },
            { email_verified: false },
            { exp: 0 },
            { iat: 0 },
            { nbf: Math.floor(now / 1000) + 60 },
            { nbf: 'tomorrow' },
            { sub: '' },
            { nonce: 'wrong' },
            { email: 'bad' },
        ])
            expect(verifyGoogleToken(jwt('nonce', claims), 'test-client', 'nonce')).toBeNull();
        expect(
            verifyGoogleToken(jwt('nonce', {}, { alg: 'HS256' }), 'test-client', 'nonce'),
        ).toBeNull();
        expect(verifyGoogleToken(jwt('nonce') + 'a', 'test-client', 'nonce')).toBeNull();
    });
    it('does not invalidate cached valid keys when an attacker supplies an unknown kid', () => {
        expect(
            verifyGoogleToken(jwt('nonce', {}, { kid: 'unknown' }), 'test-client', 'nonce'),
        ).toBeNull();
        expect(verifyGoogleToken(jwt('nonce'), 'test-client', 'nonce')).not.toBeNull();
    });
});

describe('Google and authenticator through the compiled controller', () => {
    it('uses no DB rows for initialization; rejects an unbound credential; creates and reuses a stable account', async () => {
        const start = await Auth.googleLoginStart();
        expect(start.clientId).toBe('test-client');
        const rows = () => (devDb as unknown as { store: Map<string, Buffer> }).store.size;
        expect(rows()).toBe(0);
        const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        const token = jwt(start.nonce);
        expect(
            (
                await dispatch(
                    '/auth/google/login',
                    new DataWriter().writeString(token).toBytes(),
                    'POST',
                    '',
                )
            ).status,
        ).toBe(401);
        const first = await Auth.loginWithGoogle(token);
        expect(first.length).toBeGreaterThan(0);
        expect((await dispatch('/auth/me', new Uint8Array(), 'GET')).status).toBe(200);
        expect(
            (
                await dispatch(
                    '/auth/google/login',
                    new DataWriter().writeString(token).toBytes(),
                    'POST',
                    cookie,
                )
            ).status,
        ).toBe(401);
        const second = await googleLogin();
        expect(second).toEqual(first);
        expect([...lastHeaders].some(([k, v]) => k === 'cache-control' && v === 'no-store')).toBe(
            true,
        );
    });
    it('never links by email, keeps provider identity across email changes, and permits deletion', async () => {
        const first = await googleLogin();
        await Auth.requestPasswordReset('google@example.com');
        expect(
            [...(devDb as unknown as { store: Map<string, Buffer> }).store.keys()].filter((key) =>
                key.startsWith('AuthDb/resetTokens\0'),
            ),
        ).toHaveLength(0);
        let start = await Auth.googleLoginStart();
        await expect(
            Auth.loginWithGoogle(jwt(start.nonce, { sub: 'other-sub' })),
        ).rejects.toThrow();
        start = await Auth.googleLoginStart();
        expect(
            await Auth.loginWithGoogle(jwt(start.nonce, { email: 'changed@example.com' })),
        ).toEqual(first);
        await Auth.deleteAccount();
        expect((await dispatch('/auth/me', new Uint8Array(), 'GET')).status).toBe(401);
    });

    it('serves Google login and signed sessions through the production Node HTTP server', async () => {
        mkdirSync(join(root, 'public'), { recursive: true });
        writeFileSync(
            join(root, 'public/index.html'),
            '<!doctype html><head><meta name="toil-coop" content="same-origin-allow-popups"></head><title>Auth</title>',
        );
        const probe = createServer();
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
        const port = (probe.address() as { port: number }).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        const server = await startBuiltServer({
            root,
            staticRoot: join(root, 'public'),
            wasmFile: join(root, 'main.wasm'),
            port,
            threads: 1,
        });
        try {
            const url = `http://127.0.0.1:${server.port}`;
            expect((await realFetch(url + '/')).headers.get('cross-origin-opener-policy')).toBe(
                'same-origin-allow-popups',
            );
            const startResponse = await realFetch(url + '/auth/google/start', { method: 'POST' });
            expect(startResponse.status).toBe(200);
            const start = new DataReader(new Uint8Array(await startResponse.arrayBuffer()));
            expect(start.readString()).toBe('test-client');
            const token = jwt(start.readString());
            const login = await realFetch(url + '/auth/google/login', {
                method: 'POST',
                headers: {
                    cookie: startResponse.headers
                        .getSetCookie()
                        .map((c) => c.split(';')[0])
                        .join('; '),
                },
                body: new DataWriter().writeString(token).toBytes() as BodyInit,
            });
            expect(login.status).toBe(200);
            const cookie = login.headers
                .getSetCookie()
                .filter((c) => !c.includes('Max-Age=0;'))
                .map((c) => c.split(';')[0])
                .join('; ');
            expect((await realFetch(url + '/auth/me', { headers: { cookie } })).status).toBe(200);
            const enrollment = await realFetch(url + '/auth/2fa/setup', {
                method: 'POST',
                headers: { cookie },
                body: new Uint8Array([2]),
            });
            expect(enrollment.status).toBe(200);
            expect(enrollment.headers.get('cache-control')).toBe('no-store');
            const setup = new DataReader(new Uint8Array(await enrollment.arrayBuffer()));
            expect(setup.readU8()).toBe(0);
            const secret = setup.readString();
            const confirmed = await realFetch(url + '/auth/2fa/setup/verify', {
                method: 'POST',
                headers: { cookie },
                body: new DataWriter().writeString(totp(secret)).toBytes() as BodyInit,
            });
            expect(confirmed.status).toBe(200);
            expect((await realFetch(url + '/auth/me', { headers: { cookie } })).status).toBe(401);
            const secondStart = await realFetch(url + '/auth/google/start', { method: 'POST' });
            const config = new DataReader(new Uint8Array(await secondStart.arrayBuffer()));
            config.readString();
            const pending = await realFetch(url + '/auth/google/login', {
                method: 'POST',
                headers: {
                    cookie: secondStart.headers
                        .getSetCookie()
                        .map((c) => c.split(';')[0])
                        .join('; '),
                },
                body: new DataWriter().writeString(jwt(config.readString())).toBytes() as BodyInit,
            });
            expect(pending.status).toBe(200);
            const challenge = new DataReader(new Uint8Array(await pending.arrayBuffer()));
            expect(challenge.readU8()).toBe(3);
            const id = challenge.readBytes();
            expect((await realFetch(url + '/auth/me')).status).toBe(401);
            vi.mocked(Date.now).mockReturnValue(now + 30000);
            const verified = await realFetch(url + '/auth/2fa/verify', {
                method: 'POST',
                body: new DataWriter()
                    .writeBytes(id)
                    .writeString(totp(secret))
                    .toBytes() as BodyInit,
            });
            expect(verified.status).toBe(200);
            const verifiedCookie = verified.headers
                .getSetCookie()
                .map((c) => c.split(';')[0])
                .join('; ');
            expect(
                (await realFetch(url + '/auth/me', { headers: { cookie: verifiedCookie } })).status,
            ).toBe(200);
        } finally {
            await server.close();
        }
    });

    it('binds the browser nonce to the realm and expires it', async () => {
        const start = await Auth.googleLoginStart();
        host = 'other.test';
        await expect(Auth.loginWithGoogle(jwt(start.nonce))).rejects.toThrow();
        host = 'localhost';
        vi.mocked(Date.now).mockReturnValue(now + 121000);
        await expect(Auth.loginWithGoogle(jwt(start.nonce))).rejects.toThrow();
    });
    it('requires independent confirmation of third-party Google email when the tenant requires it', async () => {
        const restore = installDevBlobEnvironment({
            vars: new Map([['AUTH_GOOGLE_CLIENT_ID', 'test-client'], ['AUTH_REQUIRE_EMAIL_CONFIRMATION', 'true']]),
            secrets: new Map([['AUTH_SESSION_SECRET', 'a'.repeat(64)]]),
        });
        try {
            await expect(googleLogin()).rejects.toBeInstanceOf(Auth.EmailNotConfirmedError);
            expect((await dispatch('/auth/me', new Uint8Array(), 'GET')).status).toBe(401);
            const start = await Auth.googleLoginStart();
            expect(await Auth.loginWithGoogle(jwt(start.nonce, {sub: 'gmail', email: 'test@gmail.com'}))).toBeInstanceOf(Uint8Array);
            const workspace = await Auth.googleLoginStart();
            expect(await Auth.loginWithGoogle(jwt(workspace.nonce, {sub: 'workspace', email: 'test@company.test', hd: 'company.test'}))).toBeInstanceOf(Uint8Array);
        } finally { restore(); }
    });

    it('isolates factor policies when tenants configure the same stable identity domain', async () => {
        const restore = installDevBlobEnvironment({
            vars: new Map([['AUTH_GOOGLE_CLIENT_ID', 'test-client']]),
            secrets: new Map([['AUTH_SESSION_SECRET', 'a'.repeat(64)], ['TOIL_AUTH_DOMAIN', 'shared.identity.test']]),
        });
        try {
            const identity = await googleLogin();
            const first = await Auth.setupAuthenticator('Toil', 'tenant-a');
            await Auth.confirmTwoFactorSetup(totp(first.secret));
            host = 'other.test'; jar.clear();
            expect(await googleLogin()).toEqual(identity);
            const second = await Auth.setupAuthenticator('Toil', 'tenant-b');
            await Auth.confirmTwoFactorSetup(totp(second.secret));
            host = 'localhost'; jar.clear();
            await expect(googleLogin()).rejects.toBeInstanceOf(TwoFactorRequiredError);
        } finally { restore(); }
    });

    it('rejects oversized second-factor identifiers before database or keyed-limiter work', async () => {
        const get = vi.spyOn(devDb, 'get');
        const response = await dispatch('/auth/2fa/verify', new DataWriter()
            .writeBytes(new Uint8Array(256)).writeString('000000').toBytes());
        expect(response.status).toBe(401);
        expect(get).not.toHaveBeenCalled();
    });

    it('commits factor policy and session revocation together even if the request fails afterward', async () => {
        await googleLogin();
        const enrollment = await Auth.setupAuthenticator('Toil', 'account');
        const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        let interrupted = false;
        await expect(module.dispatchAsync({
            method: 'POST', path: '/auth/2fa/setup/verify',
            headers: [['host', host], ['cookie', cookie]],
            body: new DataWriter().writeString(totp(enrollment.secret)).toBytes(),
        }, {
            afterDatabaseOperation: (point) => {
                if (!interrupted && point.operation === 'data.unique_claim' &&
                    ['AuthStateDb/factorRevisions', 'AuthStateDb/epochRevisions'].includes(point.collection ?? '')) {
                    interrupted = true;
                    throw new Error('injected failure after security commit');
                }
            },
        })).rejects.toThrow('injected failure');
        expect(interrupted).toBe(true);
        expect((await dispatch('/auth/me', new Uint8Array(), 'GET', cookie)).status).toBe(401);
        await expect(googleLogin()).rejects.toBeInstanceOf(TwoFactorRequiredError);
    });

    it('does not let an old wrong-code attempt overwrite a replacement enrollment', async () => {
        await googleLogin();
        await Auth.setupAuthenticator('Toil', 'first');
        const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => { entered = resolve; });
        const resume = new Promise<void>((resolve) => { release = resolve; });
        const pending = module.dispatchAsync({
            method: 'POST', path: '/auth/2fa/setup/verify',
            headers: [['host', host], ['cookie', cookie]],
            body: new DataWriter().writeString('invalid').toBytes(),
        }, {
            beforeDatabaseOperation: async (point) => {
                if (point.collection === 'AuthDb/twoFaSetup' &&
                    ['data.patch', 'data.compare_exchange'].includes(point.operation)) {
                    entered(); await resume;
                }
            },
        });
        await reached;
        const replacement = await Auth.setupAuthenticator('Toil', 'replacement');
        release();
        expect((await pending).status).toBe(401);
        await Auth.confirmTwoFactorSetup(totp(replacement.secret));
    });

    it('caps authenticator replacement guesses across source IPs', async () => {
        await googleLogin();
        const enrollment = await Auth.setupAuthenticator('Toil', 'account');
        await Auth.confirmTwoFactorSetup(totp(enrollment.secret));
        vi.mocked(Date.now).mockReturnValue(now + 30000);
        const challenge = await googleLogin().catch((e) => e);
        await Auth.verifyTwoFactor(challenge.twoFaId, totp(enrollment.secret));
        expect((await dispatch('/vectors/legacy-head')).status).toBe(200);
        expect((await dispatch('/auth/me', new Uint8Array(), 'GET')).status).toBe(200);
        __resetRatelimitForTests();
        const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        const statuses: number[] = [];
        for (let ip = 1; ip <= 6; ip++) {
            const response = module.dispatch({
                method: 'POST', path: '/auth/2fa/setup', clientIp: `192.0.2.${ip}`,
                headers: [['host', host], ['cookie', cookie]],
                body: new DataWriter().writeU8(2).writeString('invalid').toBytes(),
            });
            statuses.push(response.status);
        }
        expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it('preserves the factor policy across both logout-all and verified-session revocation', async () => {
        await googleLogin();
        const enrollment = await Auth.setupAuthenticator('Toil', 'account');
        await Auth.confirmTwoFactorSetup(totp(enrollment.secret));
        for (let step = 1; step <= 2; step++) {
            vi.mocked(Date.now).mockReturnValue(now + step * 30000);
            const challenge = await googleLogin().catch((e) => e);
            expect(challenge).toBeInstanceOf(TwoFactorRequiredError);
            await Auth.verifyTwoFactor(challenge.twoFaId, totp(enrollment.secret));
            const route = step === 1 ? '/auth/logout-all' : '/vectors/revoke-verified';
            expect((await dispatch(route)).status).toBe(200);
            expect((await dispatch('/auth/me', new Uint8Array(), 'GET')).status).toBe(401);
        }
        await expect(googleLogin()).rejects.toBeInstanceOf(TwoFactorRequiredError);
    });

    it('revokes a competing newer generation when the verified generation becomes stale', async () => {
        await googleLogin();
        const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const resume = new Promise<void>((resolve) => {
            release = resolve;
        });
        let paused = false;
        const pending = module.dispatchAsync(
            {
                method: 'POST',
                path: '/vectors/revoke-verified',
                headers: [
                    ['host', host],
                    ['cookie', cookie],
                ],
                body: new Uint8Array(),
            },
            {
                beforeDatabaseOperation: async (point) => {
                    if (
                        !paused &&
                        point.operation === 'data.unique_claim' &&
                        point.collection === 'AuthStateDb/epochRevisions'
                    ) {
                        paused = true;
                        entered();
                        await resume;
                    }
                },
            },
        );
        await reached;
        expect((await dispatch('/auth/logout-all')).status).toBe(200);
        await googleLogin();
        expect((await dispatch('/auth/me', new Uint8Array(), 'GET')).status).toBe(200);
        release();
        expect((await pending).status).toBe(200);
        expect((await dispatch('/auth/me', new Uint8Array(), 'GET')).status).toBe(401);
    });

    it('preserves a newly committed factor when a stale verified revocation loses its claim', async () => {
        await googleLogin();
        const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => { entered = resolve; });
        const resume = new Promise<void>((resolve) => { release = resolve; });
        let paused = false;
        const pending = module.dispatchAsync({
            method: 'POST', path: '/vectors/revoke-verified',
            headers: [['host', host], ['cookie', cookie]], body: new Uint8Array(),
        }, {
            beforeDatabaseOperation: async (point) => {
                if (!paused && point.operation === 'data.unique_claim' && point.collection === 'AuthStateDb/epochRevisions') {
                    paused = true; entered(); await resume;
                }
            },
        });
        await reached;
        const enrollment = await Auth.setupAuthenticator('Toil', 'account');
        await Auth.confirmTwoFactorSetup(totp(enrollment.secret));
        release();
        expect((await pending).status).toBe(200);
        await expect(googleLogin()).rejects.toBeInstanceOf(TwoFactorRequiredError);
    });

    it('allows only one concurrent challenge to consume the same authenticator step', async () => {
        await googleLogin();
        const enrollment = await Auth.setupAuthenticator('Toil', 'account');
        await Auth.confirmTwoFactorSetup(totp(enrollment.secret));
        vi.mocked(Date.now).mockReturnValue(now + 30000);
        const ids: string[] = [];
        for (let i = 0; i < 2; i++) {
            const start = await Auth.googleLoginStart();
            const error = await Auth.loginWithGoogle(jwt(start.nonce)).catch((e) => e);
            expect(error).toBeInstanceOf(TwoFactorRequiredError);
            ids.push(error.twoFaId);
        }
        let arrived = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        const responses = await Promise.all(
            ids.map((id) =>
                module.dispatchAsync(
                    {
                        method: 'POST',
                        path: '/auth/2fa/verify',
                        headers: [['host', host]],
                        body: new DataWriter()
                            .writeBytes(Buffer.from(id, 'hex'))
                            .writeString(totp(enrollment.secret))
                            .toBytes(),
                    },
                    {
                        beforeDatabaseOperation: async (point) => {
                            if (
                                point.operation === 'data.compare_exchange' &&
                                point.collection === 'AuthStateDb/totpCounters'
                            ) {
                                if (++arrived === 2) release();
                                await barrier;
                            }
                        },
                    },
                ),
            ),
        );
        expect(arrived).toBe(2);
        expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('matches RFC 6238, enrolls encrypted TOTP, gates Google login, rejects code reuse and disables with proof', async () => {
        const vector = await dispatch('/vectors/totp', new Uint8Array(), 'GET');
        expect(Buffer.from(vector.body).toString()).toBe('287082');
        await googleLogin();
        const enrollment = await Auth.setupAuthenticator('Toil', 'google@example.com');
        expect(enrollment.uri).toContain('algorithm=SHA1&digits=6&period=30');
        const stored = Buffer.concat([
            ...(devDb as unknown as { store: Map<string, Buffer> }).store.values(),
        ]);
        expect(stored.includes(Buffer.from(enrollment.secret))).toBe(false);
        let bits = '';
        for (const c of enrollment.secret)
            bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
        expect(stored.includes(Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2))))).toBe(
            false,
        );
        const code = totp(enrollment.secret);
        await expect(Auth.confirmTwoFactorSetup('invalid')).rejects.toThrow();
        await Auth.confirmTwoFactorSetup(code);
        expect((await dispatch('/auth/me', new Uint8Array(), 'GET')).status).toBe(401);
        const start = await Auth.googleLoginStart();
        const challenge = await Auth.loginWithGoogle(jwt(start.nonce)).catch((e) => e);
        expect(challenge).toBeInstanceOf(TwoFactorRequiredError);
        await expect(Auth.verifyTwoFactor(challenge.twoFaId, code)).rejects.toThrow();
        vi.mocked(Date.now).mockReturnValue(now + 30000);
        await Auth.verifyTwoFactor(challenge.twoFaId, totp(enrollment.secret));
        expect(await Auth.twoFactorStatus()).toBe(Auth.TwoFactorMethod.Authenticator);
        await expect(
            Auth.verifyTwoFactor(challenge.twoFaId, totp(enrollment.secret)),
        ).rejects.toThrow();
        await Auth.setupTwoFactor(Auth.TwoFactorMethod.None);
        vi.mocked(Date.now).mockReturnValue(now + 60000);
        await Auth.confirmTwoFactorSetup(totp(enrollment.secret));
        await googleLogin();
        expect(await Auth.twoFactorStatus()).toBe(0);
    });
});

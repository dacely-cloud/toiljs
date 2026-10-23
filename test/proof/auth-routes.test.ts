import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/compiler/index.js';
import { loadConfig, type AuthRoutesConfig } from '../../src/compiler/config.js';
import { renderAuthEmails } from '../../src/compiler/auth-emails.js';
import { Auth, SERVER_KEM_PUBLIC_KEY, TwoFactorRequiredError } from '../../src/client/auth.js';
import { WasmServerModule } from '../../src/devserver/runtime/module.js';
import { installDevBlobEnvironment } from '../../src/devserver/config/env.js';
import { __resetDbForTests, devDb } from '../../src/devserver/db/index.js';
import { __resetRatelimitForTests } from '../../src/devserver/config/ratelimit.js';
import { clearEnvCache } from '../../src/devserver/config/dotenv.js';
import { DataWriter } from '../../src/io/codec.js';
import { scaffoldAuthApp } from './auth-fixture.js';

const root = mkdtempSync(resolve('.toil-auth-routes-proof-'));
const variants: Record<string, AuthRoutesConfig> = {
    defaults: {},
    googleOff: { google: false },
    setupOff: { twoFactorSetup: false },
    bothOff: { google: false, twoFactorSetup: false },
};
let module: WasmServerModule;
let restoreEnvironment: () => void;
const jar = new Map<string, string>();
const store = (devDb as unknown as { store: Map<string, Buffer> }).store;

function useVariant(name: string) {
    module = new WasmServerModule(join(root, name, 'build/server/release.wasm'));
    module.refresh();
}
function dispatch(path: string, body = new Uint8Array(), method = 'POST') {
    const response = module.dispatch({
        method,
        path,
        body,
        headers: [
            ['host', 'localhost'],
            ['cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; ')],
        ],
    });
    for (const [name, cookie] of response.headers) {
        if (name.toLowerCase() !== 'set-cookie') continue;
        const [key, ...value] = cookie.split(';')[0].split('=');
        if (/Max-Age=0(?:;|$)/.test(cookie)) jar.delete(key);
        else jar.set(key, value.join('='));
    }
    return response;
}
async function signIn() {
    await Auth.register('policyuser', 'Strong-password-A1', 'policy@example.com');
    await Auth.login('policyuser', 'Strong-password-A1', {
        serverKemPublicKey: SERVER_KEM_PUBLIC_KEY,
    });
    expect(dispatch('/auth/me', new Uint8Array(), 'GET').status).toBe(200);
}
function totp(secret: string) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = [...secret].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const hash = createHmac('sha1', key).update(counter).digest();
    return ((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

beforeAll(async () => {
    for (const [name, policy] of Object.entries(variants)) {
        const dir = join(root, name);
        // Exercise the side-effect opt-in as well as server.auth.
        scaffoldAuthApp(dir, policy, name !== 'bothOff');
        const cfg = await loadConfig({ root: dir });
        await renderAuthEmails(cfg, true);
        await buildServer(dir, cfg.auth, cfg.authRoutes);
    }
}, 30000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
    __resetDbForTests();
    __resetRatelimitForTests();
    clearEnvCache();
    jar.clear();
    vi.spyOn(Date, 'now').mockReturnValue(Math.floor(Date.now() / 30000) * 30000 + 5000);
    restoreEnvironment = installDevBlobEnvironment({
        vars: new Map([['AUTH_GOOGLE_CLIENT_ID', 'test-client']]),
        secrets: new Map([['AUTH_SESSION_SECRET', 'a'.repeat(64)]]),
    });
    useVariant('bothOff');
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const response = dispatch(
            String(input),
            init?.body ? new Uint8Array(init.body as ArrayBuffer) : new Uint8Array(),
            init?.method ?? 'GET',
        );
        return new Response(response.body as BodyInit, { status: response.status });
    });
});
afterEach(() => {
    restoreEnvironment();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearEnvCache();
});

describe('compiled auth route policy', () => {
    it.each(Object.keys(variants))(
        'enforces independent switches from toil.config (%s)',
        async (name) => {
            useVariant(name);
            await signIn();
            const policy = variants[name];
            const start = dispatch('/auth/google/start');
            expect(start.status).toBe(policy.google === false ? 404 : 200);
            expect(
                dispatch('/auth/google/login', new DataWriter().writeString('invalid').toBytes())
                    .status,
            ).toBe(policy.google === false ? 404 : 401);
            expect(dispatch('/auth/2fa/setup', new Uint8Array([0])).status).toBe(
                policy.twoFactorSetup === false ? 404 : 200,
            );
            expect(dispatch('/auth/2fa/setup/verify').status).toBe(
                policy.twoFactorSetup === false ? 404 : 401,
            );
            expect(dispatch('/auth/me', new Uint8Array(), 'GET').status).toBe(200);
        },
    );

    it('refuses every setup method without changing state or either live cookie', async () => {
        await signIn();
        const cookies = new Map(jar);
        const before = new Map(store);
        for (const method of [0, 1, 2, 255]) {
            const response = dispatch('/auth/2fa/setup', new Uint8Array([method]));
            expect(response.status).toBe(404);
            expect(response.headers.filter(([key]) => key.toLowerCase() === 'set-cookie')).toEqual(
                [],
            );
            expect(jar).toEqual(cookies);
            expect(store).toEqual(before);
        }
        expect(
            dispatch('/auth/2fa/setup/verify', new DataWriter().writeString('123456').toBytes())
                .status,
        ).toBe(404);
        expect(store).toEqual(before);
        expect([...dispatch('/auth/2fa/status', new Uint8Array(), 'GET').body]).toEqual([0]);
    });

    it('keeps both cookies when an @auth action answers 401 while setup routes are disabled', async () => {
        await signIn();
        expect(jar.has('toil_sess') && jar.has('toil_user')).toBe(true);
        const before = new Map(jar);
        const response = dispatch('/proof/fail');
        expect(response.status).toBe(401);
        expect(response.headers).toContainEqual(['x-proof-action', 'accepted']);
        expect(Buffer.from(response.body).toString()).toBe('auth: request failed\n');
        expect(response.headers.filter(([key]) => key.toLowerCase() === 'set-cookie')).toEqual([]);
        expect(jar).toEqual(before);
        expect(dispatch('/auth/me', new Uint8Array(), 'GET').status).toBe(200);
    });

    it('still requires an enrolled factor after setup is disabled', async () => {
        useVariant('defaults');
        await signIn();
        const enrollment = await Auth.setupAuthenticator('Policy proof', 'policy@example.com');
        await Auth.confirmTwoFactorSetup(totp(enrollment.secret));
        useVariant('bothOff');
        let challenge: TwoFactorRequiredError | undefined;
        try {
            await Auth.login('policyuser', 'Strong-password-A1', {
                serverKemPublicKey: SERVER_KEM_PUBLIC_KEY,
            });
        } catch (error) {
            expect(error).toBeInstanceOf(TwoFactorRequiredError);
            challenge = error as TwoFactorRequiredError;
        }
        expect(challenge).toBeDefined();
        expect(jar.has('toil_sess')).toBe(false);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30000);
        await Auth.verifyTwoFactor(challenge!.twoFaId, totp(enrollment.secret));
        expect(dispatch('/auth/me', new Uint8Array(), 'GET').status).toBe(200);
        expect(await Auth.twoFactorStatus()).toBe(2);
    });

    it('cannot confirm an earlier pending enrollment after setup is disabled', async () => {
        useVariant('defaults');
        await signIn();
        const enrollment = await Auth.setupAuthenticator('Policy proof', 'policy@example.com');
        const before = new Map(store);
        const cookies = new Map(jar);
        useVariant('bothOff');
        const response = dispatch(
            '/auth/2fa/setup/verify',
            new DataWriter().writeString(totp(enrollment.secret)).toBytes(),
        );
        expect(response.status).toBe(404);
        expect(store).toEqual(before);
        expect(jar).toEqual(cookies);
        expect(await Auth.twoFactorStatus()).toBe(0);
    });
});

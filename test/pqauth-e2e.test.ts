/**
 * End-to-end post-quantum auth: drives the REAL browser client (`src/client/auth.ts`
 * — OPRF blind/finalize, Argon2id, ML-DSA keygen/sign, ML-KEM encapsulate,
 * mutual-auth confirm) against the toilscript-compiled example server wasm
 * (`examples/basic` Auth route + the AuthService global), through the dev-server
 * host imports (OPRF + ML-KEM mocks + the ToilDB emulator). A `fetch` shim routes
 * the client's requests into `WasmServerModule.dispatch`, and the in-process
 * ToilDB store persists across dispatches so register -> login spans "requests".
 *
 * This is the full chain interop gate: if the noble client and the
 * voprf/fips203-equivalent dev mocks + the AS AuthService disagree on a single
 * byte, register or login fails here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { ristretto255_oprf } from '@noble/curves/ed25519.js';

import { WasmServerModule } from '../src/devserver/index.js';
import { __resetDbForTests } from '../src/devserver/db/index.js';
import { Auth } from '../src/client/auth.js';
import { DataReader, DataWriter } from '../src/io/codec.js';

const EXAMPLE_WASM = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../examples/basic/build/server/release.wasm',
);

const haveWasm = fs.existsSync(EXAMPLE_WASM);

function loadModule(): WasmServerModule {
    const m = new WasmServerModule(EXAMPLE_WASM);
    m.refresh();
    return m;
}

/** Route the client's `fetch(path, {body})` into the dev wasm dispatcher. */
function installFetchShim(m: WasmServerModule): () => void {
    const original = globalThis.fetch;
    const jar = new Map<string, string>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const pathname = new URL(url, 'http://localhost').pathname;
        const bodyBytes =
            init?.body == null ? new Uint8Array(0) : new Uint8Array(init.body as ArrayBuffer);
        const headers: [string, string][] = [
            ['host', 'localhost:3000'],
            ['content-type', 'application/octet-stream'],
        ];
        if (jar.size > 0)
            headers.push(['cookie', [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')]);
        const r = m.dispatch({
            method: (init?.method ?? 'GET') as 'GET' | 'POST',
            path: pathname,
            headers,
            body: bodyBytes,
        });
        // Fold any Set-Cookie (`name=value; Path=/; ...`) into the jar so the next
        // request replays it, exactly like a browser.
        for (const [name, value] of r.headers) {
            if (name.toLowerCase() !== 'set-cookie') continue;
            const pair = value.split(';', 1)[0];
            const eq = pair.indexOf('=');
            if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
        const ab = r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength);
        return {
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            arrayBuffer: async () => ab,
            text: async () => Buffer.from(r.body).toString('utf8'),
        } as Response;
    }) as typeof fetch;
    return () => {
        globalThis.fetch = original;
    };
}

describe.skipIf(!haveWasm)('post-quantum auth end-to-end (client <-> example wasm)', () => {
    let restoreFetch: () => void;
    let mod: WasmServerModule;

    beforeEach(() => {
        __resetDbForTests();
        mod = loadModule();
        restoreFetch = installFetchShim(mod);
    });
    afterEach(() => restoreFetch());

    it(
        'registers then logs in (full OPRF + ML-DSA + ML-KEM mutual-auth chain)',
        async () => {
            await Auth.register('ada', 'correct horse battery staple');
            // login resolves ONLY if the server's mutual-auth confirmation tag
            // verified against the client's own shared secret.
            const session = await Auth.login('ada', 'correct horse battery staple');
            expect(session.length).toBeGreaterThan(0);

            // Regression guard: the freshly minted session cookie (captured by the
            // shim jar) must be ACCEPTED by the `@auth`-gated `/session/me`, which
            // runs in a separate fresh wasm instance from `login/finish`. The bug
            // was that login configured a different HMAC secret than the verify
            // path used, so the MAC failed and `/session/me` returned 401.
            const meRes = await fetch('/session/me');
            expect(meRes.status).toBe(200);
            const me = new DataReader(new Uint8Array(await meRes.arrayBuffer()));
            expect(me.readString()).toBe('ada');
            expect(me.readBool()).toBe(false); // 'ada' is not 'root' -> not admin
        },
        60_000,
    );

    it(
        'rejects /session/me with no session cookie (the @auth gate holds)',
        async () => {
            const meRes = await fetch('/session/me');
            expect(meRes.status).toBe(401);
        },
        60_000,
    );

    it(
        'rejects a wrong password at login',
        async () => {
            await Auth.register('bob', 'hunter2-correct');
            await expect(Auth.login('bob', 'hunter2-WRONG')).rejects.toThrow(/login failed|request failed/);
        },
        60_000,
    );

    it(
        'rejects login for a never-registered user',
        async () => {
            await expect(Auth.login('ghost', 'whatever')).rejects.toThrow(/login failed|request failed/);
        },
        60_000,
    );

    it(
        'rejects a duplicate registration with a clear (not generic) message',
        async () => {
            await Auth.register('dupe', 'correct horse battery staple');
            // Second registration of the same username must say so explicitly,
            // not return the generic "request failed".
            await expect(Auth.register('dupe', 'correct horse battery staple')).rejects.toThrow(
                /already registered/,
            );
        },
        60_000,
    );
});

// Lower-level wire checks that don't need the heavy Argon2id derivation.
describe.skipIf(!haveWasm)('post-quantum auth wire-level (anti-enumeration, replay)', () => {
    beforeEach(() => __resetDbForTests());

    const oprf = ristretto255_oprf.oprf;
    const loginStart = (m: WasmServerModule, username: string) => {
        const { blinded } = oprf.blind(new TextEncoder().encode('pw'));
        const body = new DataWriter().writeString(username).writeBytes(blinded).toBytes();
        const r = m.dispatch({
            method: 'POST',
            path: '/auth/login/start',
            headers: [['host', 'localhost:3000'], ['content-type', 'application/octet-stream']],
            body,
        });
        expect(r.status).toBe(200);
        const rd = new DataReader(r.body);
        const cid = rd.readBytes();
        const aud = rd.readString();
        const mem = rd.readU32();
        const iters = rd.readU32();
        const par = rd.readU32();
        const salt = rd.readBytes();
        const nonce = rd.readBytes();
        const iat = rd.readU64();
        const exp = rd.readU64();
        const evaluated = rd.readBytes();
        return { cid, aud, mem, iters, par, salt, nonce, iat, exp, evaluated };
    };
    const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

    it('returns a STABLE per-user salt for an unknown user across calls (no enumeration)', () => {
        const m = loadModule();
        const a = loginStart(m, 'no-such-user');
        const b = loginStart(m, 'no-such-user');
        // The original bug returned fresh random salt each call for unknown users.
        expect(hex(a.salt)).toBe(hex(b.salt));
        // Shape is fully formed and identical-looking to a real user's response.
        expect(a.salt.length).toBe(16);
        expect(a.nonce.length).toBe(32);
        expect(a.evaluated.length).toBe(32);
        expect(a.aud).toBe('toil-demo');
        // The randomized fields DO differ (fresh challenge each call).
        expect(hex(a.cid)).not.toBe(hex(b.cid));
    });

    it('two unknown users get different (per-user) salts', () => {
        const m = loadModule();
        const a = loginStart(m, 'alpha-unknown');
        const b = loginStart(m, 'beta-unknown');
        expect(hex(a.salt)).not.toBe(hex(b.salt));
    });
});

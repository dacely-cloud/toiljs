/**
 * End-to-end email-verification + password-reset for the BUILT-IN auth controller
 * (`server/auth/AuthController.ts`, mounted into `examples/basic` via
 * `server: { auth: true }`). Drives the REAL browser client (`src/client/auth.ts`)
 * against the toilscript-compiled example wasm through the same fetch-shim harness
 * as `pqauth-e2e.test.ts`: a `fetch` shim routes the client's requests into
 * `WasmServerModule.dispatch`, and the in-process dev ToilDB persists across
 * dispatches so a register -> login -> confirm/reset flow spans "requests".
 *
 * The confirm/reset one-time tokens are only delivered by email, so this reads
 * them out of the dev email-capture seam (`__sentEmails`) and regexes the token
 * from the emitted link. Confirmation is toggled per case via the plain env var
 * the controller reads (`AUTH_REQUIRE_EMAIL_CONFIRMATION`), set through
 * `process.env` + a dev env-cache clear.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { WasmServerModule } from '../src/devserver/index.js';
import { __resetDbForTests } from '../src/devserver/db/index.js';
import { __resetRatelimitForTests } from '../src/devserver/config/ratelimit.js';
import { clearEnvCache } from '../src/devserver/config/dotenv.js';
import { __sentEmails, __clearSentEmails } from '../src/devserver/email/index.js';
import { Auth, EmailNotConfirmedError } from '../src/client/auth.js';
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

/** Route the client's `fetch(path, {body})` into the dev wasm dispatcher (with a cookie jar). */
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

const CONFIRM_ENV = 'AUTH_REQUIRE_EMAIL_CONFIRMATION';

/** Toggle the domain's email-confirmation requirement the way the dev env store exposes plain vars:
 *  set/unset the `process.env` var, then drop the cached env snapshot so the next `Environment.get`
 *  (a per-dispatch host call) re-reads it. */
function setConfirmation(on: boolean): void {
    if (on) process.env[CONFIRM_ENV] = 'true';
    else delete process.env[CONFIRM_ENV];
    clearEnvCache();
}

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** Pull the one-time token out of the most-recent captured confirm/reset email to `to`. */
function tokenFromEmail(kind: 'confirm' | 'reset', to: string): string {
    const re = kind === 'confirm' ? /\/confirm\?token=([0-9a-f]+)/ : /\/reset\?token=([0-9a-f]+)/;
    for (let i = __sentEmails.length - 1; i >= 0; i--) {
        const msg = __sentEmails[i];
        if (msg.to !== to) continue;
        const hit = re.exec(msg.text) ?? re.exec(msg.html);
        if (hit) return hit[1];
    }
    throw new Error(
        `no ${kind} token emailed to ${to}; captured=${JSON.stringify(
            __sentEmails.map((e) => ({ to: e.to, purpose: e.purpose })),
        )}`,
    );
}

describe.skipIf(!haveWasm)('built-in auth: email verification + password reset (client <-> example wasm)', () => {
    let restoreFetch: () => void;
    let mod: WasmServerModule;

    beforeEach(() => {
        __resetDbForTests();
        // The controller decorates every route with `@ratelimit`; the dev limiter is a module
        // singleton, so reset it per case to keep the many dispatches across this file isolated.
        __resetRatelimitForTests();
        __clearSentEmails();
        setConfirmation(false); // default: confirmation off unless a case opts in
        mod = loadModule();
        restoreFetch = installFetchShim(mod);
    });
    afterEach(() => {
        restoreFetch();
        setConfirmation(false);
    });

    it(
        'confirmation OFF (default): register auto-confirms, login succeeds, /auth/me returns the user',
        async () => {
            await Auth.register('ada', 'correct horse battery staple', 'ada@example.com');
            const session = await Auth.login('ada', 'correct horse battery staple');
            expect(session.length).toBeGreaterThan(0);

            // The controller's `@auth`-gated /auth/me returns bytes(toilUserId) str(username).
            const meRes = await fetch('/auth/me');
            expect(meRes.status).toBe(200);
            const me = new DataReader(new Uint8Array(await meRes.arrayBuffer()));
            expect(me.readBytes().length).toBeGreaterThan(0); // stable toilUserId
            expect(me.readString()).toBe('ada');

            // No confirmation required -> no email was sent.
            expect(__sentEmails.length).toBe(0);
        },
        60_000,
    );

    it(
        'confirmation ON: login is refused until the emailed token confirms the account',
        async () => {
            setConfirmation(true);
            await Auth.register('bob', 'hunter2-correct', 'bob@example.com');

            // A valid credential is not enough: the domain requires a confirmed email.
            await expect(Auth.login('bob', 'hunter2-correct')).rejects.toThrow(EmailNotConfirmedError);

            // Read the confirm link out of the captured email and confirm.
            const token = tokenFromEmail('confirm', 'bob@example.com');
            await Auth.confirmEmail(token);

            // Now login succeeds.
            const session = await Auth.login('bob', 'hunter2-correct');
            expect(session.length).toBeGreaterThan(0);
        },
        60_000,
    );

    it(
        'duplicate email is rejected at registration (distinct "email already in use")',
        async () => {
            await Auth.register('carol', 'carol-pw-strong', 'dupe@x.com');
            await expect(Auth.register('dave', 'dave-pw-strong', 'dupe@x.com')).rejects.toThrow(
                /email already in use/,
            );
        },
        60_000,
    );

    it(
        'password reset round trip: old password stops working, the new one logs in',
        async () => {
            await Auth.register('erin', 'oldpw-erin-strong', 'erin@x.com');
            // Sanity: confirmation is off, so she can log in before the reset.
            expect((await Auth.login('erin', 'oldpw-erin-strong')).length).toBeGreaterThan(0);

            await Auth.requestPasswordReset('erin@x.com');
            const token = tokenFromEmail('reset', 'erin@x.com');
            await Auth.resetPassword(token, 'newpw-erin-strong');

            await expect(Auth.login('erin', 'oldpw-erin-strong')).rejects.toThrow(
                /login failed|request failed/,
            );
            expect((await Auth.login('erin', 'newpw-erin-strong')).length).toBeGreaterThan(0);
        },
        60_000,
    );

    it(
        'non-enumeration: reset/resend for an unknown email resolve and send NOTHING',
        async () => {
            __clearSentEmails();
            await expect(Auth.requestPasswordReset('nobody@x.com')).resolves.toBeUndefined();
            await expect(Auth.resendConfirmation('nobody@x.com')).resolves.toBeUndefined();
            expect(__sentEmails.length).toBe(0);
        },
        60_000,
    );

    it(
        'a reset token is one-time: replaying /auth/reset/finish with the consumed token fails',
        async () => {
            await Auth.register('frank', 'oldpw-frank-strong', 'frank@x.com');
            await Auth.requestPasswordReset('frank@x.com');
            const tokenHex = tokenFromEmail('reset', 'frank@x.com');
            await Auth.resetPassword(tokenHex, 'newpw-frank-strong'); // consumes the token

            // Replay reset/finish with a valid-length pk/proof so the controller reaches the
            // token-consume step, which now finds the token already deleted -> generic fail.
            const body = new DataWriter()
                .writeBytes(hexToBytes(tokenHex))
                .writeBytes(new Uint8Array(1312)) // AuthService.PUBLIC_KEY_LEN (ML-DSA-44)
                .writeBytes(new Uint8Array(2420)) // AuthService.SIGNATURE_LEN
                .toBytes();
            const r = mod.dispatch({
                method: 'POST',
                path: '/auth/reset/finish',
                headers: [
                    ['host', 'localhost:3000'],
                    ['content-type', 'application/octet-stream'],
                ],
                body,
            });
            expect(r.status).not.toBe(200);
        },
        60_000,
    );
});

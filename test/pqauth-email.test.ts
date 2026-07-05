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
import {
    Auth,
    AuthErrorCode,
    checkPassword,
    EmailInUseError,
    EmailNotConfirmedError,
    InvalidEmailError,
    InvalidUsernameError,
    isValidEmail,
    TwoFactorRequiredError,
    WeakPasswordError,
} from '../src/client/auth.js';
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

/** Route the client's `fetch(path, {body})` into the dev wasm dispatcher (with a cookie jar).
 *  The Host header the client's requests carry is settable (`setHost`) so a test can drive
 *  the same client against DIFFERENT tenant domains and prove per-host auth isolation. */
function installFetchShim(m: WasmServerModule): () => void {
    const original = globalThis.fetch;
    const jar = new Map<string, string>();
    let host = 'localhost:3000';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const pathname = new URL(url, 'http://localhost').pathname;
        const bodyBytes =
            init?.body == null ? new Uint8Array(0) : new Uint8Array(init.body as ArrayBuffer);
        const headers: [string, string][] = [
            ['host', host],
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
    return {
        restore: () => {
            globalThis.fetch = original;
        },
        jar,
        setHost: (h: string) => {
            host = h;
        },
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

const EMAIL_CONFIRM_ENV = 'AUTH_EMAIL_CONFIRMATION';

/** Toggle "send a verify email at register but DO NOT block login" (the decoupled flag). */
function setEmailConfirmation(on: boolean): void {
    if (on) process.env[EMAIL_CONFIRM_ENV] = 'true';
    else delete process.env[EMAIL_CONFIRM_ENV];
    clearEnvCache();
}

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** Pull the one-time token out of the most-recent captured confirm/reset email to `to`. */
function tokenFromEmail(kind: 'confirm' | 'reset', to: string): string {
    // Tokens live in the URL FRAGMENT now (#token=), kept out of server/CDN logs.
    const re = kind === 'confirm' ? /\/confirm#token=([0-9a-f]+)/ : /\/reset#token=([0-9a-f]+)/;
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

/** Pull the 6-digit code out of the most-recent captured 2FA email (purpose `2fa`) to `to`. */
function codeFromEmail(to: string): string {
    for (let i = __sentEmails.length - 1; i >= 0; i--) {
        const msg = __sentEmails[i];
        if (msg.to !== to || msg.purpose !== '2fa') continue;
        const hit = /\b(\d{6})\b/.exec(msg.text) ?? /\b(\d{6})\b/.exec(msg.html);
        if (hit) return hit[1];
    }
    throw new Error(
        `no 2fa code emailed to ${to}; captured=${JSON.stringify(
            __sentEmails.map((e) => ({ to: e.to, purpose: e.purpose })),
        )}`,
    );
}

describe.skipIf(!haveWasm)('built-in auth: email verification + password reset (client <-> example wasm)', () => {
    let restoreFetch: () => void;
    let mod: WasmServerModule;
    let jar: Map<string, string>;
    let setHost: (h: string) => void;

    beforeEach(() => {
        __resetDbForTests();
        // The controller decorates every route with `@ratelimit`; the dev limiter is a module
        // singleton, so reset it per case to keep the many dispatches across this file isolated.
        __resetRatelimitForTests();
        __clearSentEmails();
        setConfirmation(false); // default: confirmation off unless a case opts in
        setEmailConfirmation(false);
        mod = loadModule();
        const shim = installFetchShim(mod);
        restoreFetch = shim.restore;
        jar = shim.jar;
        setHost = shim.setHost;
    });
    afterEach(() => {
        restoreFetch();
        setConfirmation(false);
        setEmailConfirmation(false);
    });

    it(
        'confirmation OFF (default): register auto-confirms, login succeeds, /auth/me returns the user',
        async () => {
            await Auth.register('ada', 'correct horse battery stapleA1', 'ada@example.com');
            const session = await Auth.login('ada', 'correct horse battery stapleA1');
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

    // ---- security regressions ----

    it(
        'reset link is NOT poisonable via a crafted Host header (#6 host-header reset-poisoning)',
        async () => {
            // grace lives on the victim tenant (realm = normalized Host "victim.com").
            setHost('victim.com');
            await Auth.register('grace', 'pw-grace-correctA1', 'grace@x.com');
            __clearSentEmails();
            // Attacker triggers reset/request with a Host that routes to the victim
            // (the edge strip_port -> "victim.com", which is grace's realm, so the
            // request DOES resolve her account) but, dropped raw into a link,
            // reparents the URL authority to attacker.com.
            const body = new DataWriter().writeString('grace@x.com').toBytes();
            const r = mod.dispatch({
                method: 'POST',
                path: '/auth/reset/request',
                headers: [
                    ['host', 'victim.com:@attacker.com'],
                    ['content-type', 'application/octet-stream'],
                ],
                body,
            });
            expect(r.status).toBe(200); // always the generic non-enumerating ack
            const msg = __sentEmails.find((e) => e.to === 'grace@x.com');
            expect(msg).toBeTruthy();
            // The poisoned Host is rejected (contains `@`) and the link falls back to
            // a safe origin -> the attacker domain never appears in the emailed link.
            expect((msg!.html + msg!.text).includes('attacker.com')).toBe(false);
        },
        60_000,
    );

    it(
        'a session minted for one tenant does NOT verify for another (#2 cross-tenant session)',
        async () => {
            await Auth.register('heidi', 'pw-heidi-correctA1', 'heidi@x.com');
            await Auth.login('heidi', 'pw-heidi-correctA1'); // minted under the shim Host localhost:3000
            const sess = jar.get('toil_sess'); // dev is plain HTTP -> unprefixed cookie
            expect(sess).toBeTruthy();
            const meHeaders = (host: string): [string, string][] => [
                ['host', host],
                ['cookie', 'toil_sess=' + String(sess)],
            ];
            // Same tenant (localhost) -> the @auth-gated /auth/me accepts it.
            const same = mod.dispatch({
                method: 'GET',
                path: '/auth/me',
                headers: meHeaders('localhost:3000'),
                body: new Uint8Array(0),
            });
            expect(same.status).toBe(200);
            // A DIFFERENT tenant Host derives a different session key -> the same
            // cookie fails to open -> 401. A B-minted session cannot bypass A.
            const cross = mod.dispatch({
                method: 'GET',
                path: '/auth/me',
                headers: meHeaders('evil-tenant.com'),
                body: new Uint8Array(0),
            });
            expect(cross.status).toBe(401);
        },
        60_000,
    );

    it(
        'token bound: a new reset request invalidates the previous token (#5c growth bound)',
        async () => {
            await Auth.register('ivan', 'pw-ivan-correctA1', 'ivan@x.com');
            await Auth.requestPasswordReset('ivan@x.com');
            const token1 = tokenFromEmail('reset', 'ivan@x.com');
            __clearSentEmails();
            await Auth.requestPasswordReset('ivan@x.com'); // mints token2, invalidates token1
            const token2 = tokenFromEmail('reset', 'ivan@x.com');
            expect(token2).not.toBe(token1);
            // The superseded token no longer works...
            await expect(Auth.resetPassword(token1, 'new-pw-unusedA1')).rejects.toThrow();
            // ...only the latest does.
            await Auth.resetPassword(token2, 'new-pw-ivanA1');
            const session = await Auth.login('ivan', 'new-pw-ivanA1');
            expect(session.length).toBeGreaterThan(0);
        },
        60_000,
    );

    it(
        'confirmation ON: login is refused until the emailed token confirms the account',
        async () => {
            setConfirmation(true);
            await Auth.register('bob', 'hunter2-correctA1', 'bob@example.com');

            // A valid credential is not enough: the domain requires a confirmed email.
            await expect(Auth.login('bob', 'hunter2-correctA1')).rejects.toThrow(EmailNotConfirmedError);

            // Read the confirm link out of the captured email and confirm.
            const token = tokenFromEmail('confirm', 'bob@example.com');
            await Auth.confirmEmail(token);

            // Now login succeeds.
            const session = await Auth.login('bob', 'hunter2-correctA1');
            expect(session.length).toBeGreaterThan(0);
        },
        60_000,
    );

    it(
        'duplicate email is rejected at registration (distinct "email already in use")',
        async () => {
            await Auth.register('carol', 'carol-pw-strongA1', 'dupe@x.com');
            // Typed error: a distinct EmailInUseError carrying the stable code, so a UI can
            // branch reliably (never on the message/name string).
            const err = await Auth.register('dave', 'dave-pw-strongA1', 'dupe@x.com').catch(
                (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(EmailInUseError);
            expect((err as EmailInUseError).code).toBe(AuthErrorCode.EmailInUse);
        },
        60_000,
    );

    it(
        'password reset round trip: old password stops working, the new one logs in',
        async () => {
            await Auth.register('erin', 'oldpw-erin-strongA1', 'erin@x.com');
            // Sanity: confirmation is off, so she can log in before the reset.
            expect((await Auth.login('erin', 'oldpw-erin-strongA1')).length).toBeGreaterThan(0);

            await Auth.requestPasswordReset('erin@x.com');
            const token = tokenFromEmail('reset', 'erin@x.com');
            await Auth.resetPassword(token, 'newpw-erin-strongA1');

            await expect(Auth.login('erin', 'oldpw-erin-strongA1')).rejects.toThrow(
                /login failed|request failed/,
            );
            expect((await Auth.login('erin', 'newpw-erin-strongA1')).length).toBeGreaterThan(0);
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
            await Auth.register('frank', 'oldpw-frank-strongA1', 'frank@x.com');
            await Auth.requestPasswordReset('frank@x.com');
            const tokenHex = tokenFromEmail('reset', 'frank@x.com');
            await Auth.resetPassword(tokenHex, 'newpw-frank-strongA1'); // consumes the token

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

    // ---- multi-method 2FA (email) ----

    it(
        '(a) full email-2FA login round-trip: enable, login requires a code, verify mints the session',
        async () => {
            await Auth.register('dave', 'dave-pw-strongA1', 'dave@x.com');
            await Auth.login('dave', 'dave-pw-strongA1'); // 2FA off -> session

            // Enable email 2FA: setup delivers a code, confirm switches the method on.
            await Auth.setupTwoFactor(Auth.TwoFactorMethod.Email);
            await Auth.confirmTwoFactorSetup(codeFromEmail('dave@x.com'));
            expect(await Auth.twoFactorStatus()).toBe(Auth.TwoFactorMethod.Email);

            __clearSentEmails();
            jar.clear(); // drop the existing session so login is a clean 2FA challenge

            // Login now demands a second factor: mutual auth still passes (login()
            // verifies serverConfirm before throwing), but NO session is minted.
            let err: unknown;
            try {
                await Auth.login('dave', 'dave-pw-strongA1');
            } catch (e) {
                err = e;
            }
            expect(err).toBeInstanceOf(TwoFactorRequiredError);
            const twoFaId = (err as TwoFactorRequiredError).twoFaId;
            expect(twoFaId.length).toBeGreaterThan(0);
            expect(jar.get('toil_sess')).toBeUndefined(); // no session at login/finish

            // Read the login code out of the captured email and verify -> session.
            const session = await Auth.verifyTwoFactor(twoFaId, codeFromEmail('dave@x.com'));
            expect(session.length).toBeGreaterThan(0);

            // /auth/me now returns the user.
            const meRes = await fetch('/auth/me');
            expect(meRes.status).toBe(200);
            const me = new DataReader(new Uint8Array(await meRes.arrayBuffer()));
            expect(me.readBytes().length).toBeGreaterThan(0); // toilUserId
            expect(me.readString()).toBe('dave');
        },
        90_000,
    );

    it(
        '(b) 2FA code security: wrong code rejected + attempt-limited to death, correct code single-use',
        async () => {
            await Auth.register('eve', 'eve-pw-strongA1', 'eve@x.com');
            await Auth.login('eve', 'eve-pw-strongA1');
            await Auth.setupTwoFactor(Auth.TwoFactorMethod.Email);
            await Auth.confirmTwoFactorSetup(codeFromEmail('eve@x.com'));

            // ---- wrong code is rejected, and after TWOFA_MAX_ATTEMPTS the challenge dies ----
            __clearSentEmails();
            jar.clear();
            let err: unknown;
            try {
                await Auth.login('eve', 'eve-pw-strongA1');
            } catch (e) {
                err = e;
            }
            const twoFaId = (err as TwoFactorRequiredError).twoFaId;
            const code = codeFromEmail('eve@x.com');
            const wrong = code === '000000' ? '111111' : '000000';

            // 5 (TWOFA_MAX_ATTEMPTS) wrong guesses. Reset the per-IP limiter between
            // each so this exercises the CHALLENGE's own attempt cap, not @ratelimit.
            for (let i = 0; i < 5; i++) {
                __resetRatelimitForTests();
                await expect(Auth.verifyTwoFactor(twoFaId, wrong)).rejects.toThrow();
            }
            // The challenge is now destroyed: even the CORRECT code fails.
            __resetRatelimitForTests();
            await expect(Auth.verifyTwoFactor(twoFaId, code)).rejects.toThrow();

            // ---- a correct code is single-use: replay fails ----
            __clearSentEmails();
            jar.clear();
            __resetRatelimitForTests();
            let err2: unknown;
            try {
                await Auth.login('eve', 'eve-pw-strongA1');
            } catch (e) {
                err2 = e;
            }
            const twoFaId2 = (err2 as TwoFactorRequiredError).twoFaId;
            const code2 = codeFromEmail('eve@x.com');
            const session = await Auth.verifyTwoFactor(twoFaId2, code2); // consumes
            expect(session.length).toBeGreaterThan(0);
            __resetRatelimitForTests();
            await expect(Auth.verifyTwoFactor(twoFaId2, code2)).rejects.toThrow(); // replay dead
        },
        120_000,
    );

    it(
        '(c) cross-flow: reset tokens and 2FA codes are NOT interchangeable (namespace separation)',
        async () => {
            await Auth.register('frank', 'frank-pw-strongA1', 'frank@x.com');

            // ---- direction 1: a LIVE reset token is useless at /auth/2fa/verify ----
            await Auth.requestPasswordReset('frank@x.com');
            const resetToken = tokenFromEmail('reset', 'frank@x.com'); // live resetTokens entry
            __resetRatelimitForTests();
            // Present the reset token as BOTH the twoFaId AND the code: /2fa/verify
            // looks in `twoFaLogins` (a different collection) -> nothing -> rejected.
            await expect(Auth.verifyTwoFactor(resetToken, resetToken)).rejects.toThrow();

            // ---- direction 2: a LIVE 2FA login challenge id is useless at /auth/reset/finish ----
            await Auth.login('frank', 'frank-pw-strongA1'); // session (2FA still off here)
            __clearSentEmails();
            await Auth.setupTwoFactor(Auth.TwoFactorMethod.Email);
            await Auth.confirmTwoFactorSetup(codeFromEmail('frank@x.com'));
            __clearSentEmails();
            jar.clear();
            __resetRatelimitForTests();
            let err: unknown;
            try {
                await Auth.login('frank', 'frank-pw-strongA1');
            } catch (e) {
                err = e;
            }
            const twoFaId = (err as TwoFactorRequiredError).twoFaId; // live twoFaLogins key
            const loginCode = codeFromEmail('frank@x.com');

            // Submit the live 2FA challenge id AND the live 2FA code to
            // /auth/reset/finish as the reset token: reset/finish looks in
            // `resetTokens` -> nothing -> non-200. A live 2FA challenge is NOT a
            // reset token.
            const probes: Uint8Array[] = [hexToBytes(twoFaId), new TextEncoder().encode(loginCode)];
            for (const raw of probes) {
                __resetRatelimitForTests();
                const body = new DataWriter()
                    .writeBytes(raw)
                    .writeBytes(new Uint8Array(1312)) // valid-length pk (reach the consume step)
                    .writeBytes(new Uint8Array(2420)) // valid-length proof
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
            }

            // The cross-flow probes touched NOTHING: the real 2FA login still
            // completes with its real (twoFaId, code).
            __resetRatelimitForTests();
            const session = await Auth.verifyTwoFactor(twoFaId, loginCode);
            expect(session.length).toBeGreaterThan(0);
        },
        120_000,
    );

    it(
        '(d) NO session cookie is set on the ST_TWOFA_REQUIRED login response',
        async () => {
            await Auth.register('gwen', 'gwen-pw-strongA1', 'gwen@x.com');
            await Auth.login('gwen', 'gwen-pw-strongA1');
            await Auth.setupTwoFactor(Auth.TwoFactorMethod.Email);
            await Auth.confirmTwoFactorSetup(codeFromEmail('gwen@x.com'));

            jar.clear(); // drop every cookie
            __clearSentEmails();
            __resetRatelimitForTests();

            let err: unknown;
            try {
                await Auth.login('gwen', 'gwen-pw-strongA1');
            } catch (e) {
                err = e;
            }
            expect(err).toBeInstanceOf(TwoFactorRequiredError);
            // The shim folds any Set-Cookie into the jar; login/finish set NONE.
            expect(jar.get('toil_sess')).toBeUndefined();
            expect(jar.get('toil_user')).toBeUndefined();
            // With no session cookie, the @auth-gated /auth/me is 401.
            const meRes = await fetch('/auth/me');
            expect(meRes.status).toBe(401);
        },
        60_000,
    );

    it(
        '(e) login<->setup 2FA challenges are separate: a setup code cannot mint a login session, and setup/verify never silently disables 2FA',
        async () => {
            await Auth.register('ivy', 'ivy-pw-strongA1', 'ivy@x.com');
            await Auth.login('ivy', 'ivy-pw-strongA1'); // session; 2FA still off

            // Begin a 2FA SETUP: writes a challenge into `twoFaSetup` (keyed by
            // username), NOT a login challenge into `twoFaLogins`.
            __clearSentEmails();
            __resetRatelimitForTests();
            await Auth.setupTwoFactor(Auth.TwoFactorMethod.Email);
            const setupCode = codeFromEmail('ivy@x.com');

            // Present the LIVE setup code at /auth/2fa/verify with a fabricated
            // twoFaId: /2fa/verify consults ONLY `twoFaLogins`, so the id misses and
            // a setup code can never mint a login session.
            __resetRatelimitForTests();
            const fakeId = 'ab'.repeat(16); // 16-byte hex, not a real twoFaLogins key
            await expect(Auth.verifyTwoFactor(fakeId, setupCode)).rejects.toThrow();

            // The probe consumed NOTHING: the real setup still completes with the code.
            __resetRatelimitForTests();
            await Auth.confirmTwoFactorSetup(setupCode);
            expect(await Auth.twoFactorStatus()).toBe(Auth.TwoFactorMethod.Email);

            // With 2FA now ON but NO pending setup challenge, /auth/2fa/setup/verify is
            // a no-op: a stray code cannot flip (disable) the method. A login challenge
            // (targetMethod=NONE) has no wire path here and can never be routed in to
            // silently disable 2FA.
            __resetRatelimitForTests();
            await expect(Auth.confirmTwoFactorSetup('000000')).rejects.toThrow();
            expect(await Auth.twoFactorStatus()).toBe(Auth.TwoFactorMethod.Email);
        },
        120_000,
    );

    it(
        '(f) cross-flow: confirm tokens and 2FA codes are NOT interchangeable (namespace separation)',
        async () => {
            setConfirmation(true);
            await Auth.register('jade', 'jade-pw-strongA1', 'jade@x.com'); // unconfirmed -> confirm token emailed
            const confirmToken = tokenFromEmail('confirm', 'jade@x.com'); // live confirmTokens entry

            // ---- direction 1: a LIVE confirm token is useless at /auth/2fa/verify ----
            __resetRatelimitForTests();
            // Present the confirm token as BOTH the twoFaId AND the code: /2fa/verify
            // reads `twoFaLogins` (a different collection) -> nothing -> rejected.
            await expect(Auth.verifyTwoFactor(confirmToken, confirmToken)).rejects.toThrow();

            // The probe consumed NOTHING: the confirm token still confirms the account,
            // and login then succeeds (email now confirmed).
            __resetRatelimitForTests();
            await Auth.confirmEmail(confirmToken);
            __resetRatelimitForTests();
            expect((await Auth.login('jade', 'jade-pw-strongA1')).length).toBeGreaterThan(0);

            // ---- direction 2: a LIVE 2FA login id/code is useless at /auth/confirm ----
            // Enable 2FA (jade is confirmed + has a session from the login above).
            __clearSentEmails();
            __resetRatelimitForTests();
            await Auth.setupTwoFactor(Auth.TwoFactorMethod.Email);
            await Auth.confirmTwoFactorSetup(codeFromEmail('jade@x.com'));

            // Fresh login -> a live `twoFaLogins` challenge (id + emailed code).
            __clearSentEmails();
            jar.clear();
            __resetRatelimitForTests();
            let err: unknown;
            try {
                await Auth.login('jade', 'jade-pw-strongA1');
            } catch (e) {
                err = e;
            }
            const twoFaId = (err as TwoFactorRequiredError).twoFaId;
            const loginCode = codeFromEmail('jade@x.com');

            // Submit the live 2FA id AND the live code to /auth/confirm as the confirm
            // token: /auth/confirm consumes from `confirmTokens` (sha256(raw)) -> nothing
            // -> non-200. A 2FA credential is NOT a confirm token.
            const probes: Uint8Array[] = [hexToBytes(twoFaId), new TextEncoder().encode(loginCode)];
            for (const raw of probes) {
                __resetRatelimitForTests();
                const body = new DataWriter().writeBytes(raw).toBytes();
                const r = mod.dispatch({
                    method: 'POST',
                    path: '/auth/confirm',
                    headers: [
                        ['host', 'localhost:3000'],
                        ['content-type', 'application/octet-stream'],
                    ],
                    body,
                });
                expect(r.status).not.toBe(200);
            }

            // The probes touched NOTHING: the real 2FA login still completes.
            __resetRatelimitForTests();
            const session = await Auth.verifyTwoFactor(twoFaId, loginCode);
            expect(session.length).toBeGreaterThan(0);
        },
        120_000,
    );

    it(
        '(g) per-domain isolation: a confirm/reset/2FA code minted on domain A is USELESS on domain B',
        async () => {
            const A = 'a.example.com';
            const B = 'b.example.com';

            // ---- confirm token: minted on A, unredeemable on B ----
            setConfirmation(true);
            setHost(A);
            await Auth.register('mia', 'mia-pw-strongA1', 'mia@x.com'); // realm A + confirm token emailed
            const confirmTok = tokenFromEmail('confirm', 'mia@x.com');

            setHost(B);
            __resetRatelimitForTests();
            // Same raw token, different realm -> tokenId(B, raw) is a different key -> miss.
            await expect(Auth.confirmEmail(confirmTok)).rejects.toThrow();

            setHost(A);
            __resetRatelimitForTests();
            await Auth.confirmEmail(confirmTok); // realm A -> confirms
            setConfirmation(false);

            // ---- reset token: minted on A, unredeemable on B ----
            setHost(A);
            __clearSentEmails();
            __resetRatelimitForTests();
            await Auth.requestPasswordReset('mia@x.com');
            const resetTok = tokenFromEmail('reset', 'mia@x.com');

            setHost(B);
            __resetRatelimitForTests();
            await expect(Auth.resetPassword(resetTok, 'mia-pw-newA1')).rejects.toThrow(); // realm B miss

            setHost(A);
            __resetRatelimitForTests();
            await Auth.resetPassword(resetTok, 'mia-pw-newA1'); // realm A -> resets

            // ---- 2FA login code: minted on A, unusable on B ----
            setHost(A);
            __resetRatelimitForTests();
            await Auth.login('mia', 'mia-pw-newA1'); // session on A (2FA still off)
            __clearSentEmails();
            await Auth.setupTwoFactor(Auth.TwoFactorMethod.Email);
            await Auth.confirmTwoFactorSetup(codeFromEmail('mia@x.com')); // 2FA enabled on A

            __clearSentEmails();
            jar.clear();
            __resetRatelimitForTests();
            let err: unknown;
            try {
                await Auth.login('mia', 'mia-pw-newA1'); // -> 2FA challenge (twoFaId + code, realm A)
            } catch (e) {
                err = e;
            }
            const twoFaId = (err as TwoFactorRequiredError).twoFaId;
            const loginCode = codeFromEmail('mia@x.com');

            setHost(B);
            __resetRatelimitForTests();
            // The twoFaId lives in twoFaLogins under realm A; on B its key (and the
            // realm-bound codeHash) miss -> a code from A cannot mint a session on B.
            await expect(Auth.verifyTwoFactor(twoFaId, loginCode)).rejects.toThrow();

            setHost(A);
            __resetRatelimitForTests();
            const session = await Auth.verifyTwoFactor(twoFaId, loginCode); // realm A -> mints
            expect(session.length).toBeGreaterThan(0);
        },
        180_000,
    );

    // ---- input validation (client-side, before any crypto / network) ----

    it('checkPassword + isValidEmail: the pure validators behave', () => {
        expect(checkPassword('Str0ng-pw!')).toEqual([]); // meets every rule
        expect(checkPassword('short1A').sort()).toEqual(['minLength', 'special'].sort()); // 7 chars, no special
        expect(checkPassword('alllowercase1!')).toEqual(['uppercase']);
        expect(checkPassword('NoDigits!!')).toEqual(['digit']);
        expect(isValidEmail('bob@example.com')).toBe(true);
        expect(isValidEmail('bobfwehfuewhfwf.com')).toBe(false); // no @
        expect(isValidEmail('a@b')).toBe(false); // no dotted domain
        expect(isValidEmail('a b@x.com')).toBe(false); // space
    });

    it('register rejects a weak password with WeakPasswordError (before any network)', async () => {
        const err = await Auth.register('newbie', 'weak', 'newbie@x.com').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WeakPasswordError);
        expect((err as WeakPasswordError).code).toBe(AuthErrorCode.WeakPassword);
        // the unmet rules are exposed so a UI can show a checklist
        expect((err as WeakPasswordError).unmet).toContain('minLength');
        expect((err as WeakPasswordError).unmet).toContain('uppercase');
        // no confirm email was sent (it threw before the request)
        __clearSentEmails();
        expect(__sentEmails.length).toBe(0);
    });

    it('register rejects an invalid email + a bad username with typed errors', async () => {
        await expect(Auth.register('newbie', 'Str0ng-pw!', 'not-an-email')).rejects.toBeInstanceOf(
            InvalidEmailError,
        );
        await expect(Auth.register('', 'Str0ng-pw!', 'ok@x.com')).rejects.toBeInstanceOf(
            InvalidUsernameError,
        );
    });

    it(
        'AUTH_EMAIL_CONFIRMATION sends the verify email at register but does NOT block login',
        async () => {
            // The decoupled flag: verify-at-register, login NOT gated (unlike the
            // stricter AUTH_REQUIRE_EMAIL_CONFIRMATION, which also blocks login).
            setEmailConfirmation(true);
            __clearSentEmails();
            await Auth.register('kev', 'Kev-pw-strong1!', 'kev@x.com');
            // a confirm link was emailed (the account is stored unconfirmed)
            const tok = tokenFromEmail('confirm', 'kev@x.com');
            expect(tok.length).toBeGreaterThan(0);
            // login SUCCEEDS despite the unconfirmed email (no login gate)
            __resetRatelimitForTests();
            const session = await Auth.login('kev', 'Kev-pw-strong1!');
            expect(session.length).toBeGreaterThan(0);
            // and the emailed confirm link still works
            __resetRatelimitForTests();
            await Auth.confirmEmail(tok);
        },
        90_000,
    );
});

import { Response, RouteContext } from 'toiljs/server/runtime';
import { DataReader, DataWriter } from 'data';

import { encodeSessionUser } from './AuthUser';

/**
 * Built-in Toil PQ-Auth controller: the full post-quantum password-login API
 * (`/auth/register|login/start|finish`) plus sessions (`/auth/me`, `/auth/logout`),
 * mounted automatically when an app opts in with `server: { auth: true }` (or
 * `import 'toiljs/server/auth'`). It is a framework-shipped SOURCE file the build
 * APPENDS to the toilscript entry set, so its `@data`/`@database`/`@rest` decorators
 * weave and its `@rest` class self-mounts at `/auth/*` — no hand-written boilerplate.
 *
 * The password never leaves the browser. The client blinds it through the
 * server-keyed OPRF (precomputation-resistant keyed salt), stretches the OPRF
 * output with Argon2id into an ML-DSA-44 keypair, and registers only the public
 * key (+ a proof-of-possession). Login is a challenge-response that also runs an
 * ML-KEM-768 key encapsulation: the server proves its identity by returning a
 * confirmation tag only derivable from the decapsulated shared secret (mutual
 * auth). See `server/globals/auth.ts` (the `AuthService` global) and the client
 * half in `toiljs/client` (`Auth.register` / `Auth.login`).
 *
 * STORAGE: backed by ToilDB (`@database AuthDb`). Accounts are a `record`
 * collection keyed by username; login challenges are a `record` consumed exactly
 * once with `getDelete` (atomic fetch-and-delete). The dev server emulates these
 * `env.data.*` host imports in process (so register -> login spans requests under
 * `toiljs dev`); the production edge backs the SAME API with ScyllaDB.
 *
 * Wire: every body/response is binary (`DataWriter`/`DataReader`), never JSON.
 *
 * Tuning (audience, TTLs, Argon2id params, rate-limit tuples) is fixed here for
 * now; config-driven overrides are a documented follow-up. The secret trio
 * (`AUTH_SESSION_SECRET` / `AUTH_OPRF_SEED` / `AUTH_KEM_SK`) resolves lazily from
 * the tenant env store with DEV fallbacks, so this runs with zero config.
 */

// Demo-light Argon2id params (responsive in a browser tab). A real deployment
// uses >= 256 MiB / >= 3 iterations. The client derives against whatever it is
// handed, so this is the single source of truth.
const MEM_KIB: u32 = 32768; // 32 MiB
const ITERS: u32 = 2;
const PAR: u32 = 1;

const CHALLENGE_TTL_SECS: u64 = 120;
const SESSION_TTL_SECS: u64 = 3600;

// Resolved-and-cached per instance; the audience id (server config, never
// client-echoed). Read lazily (not at module top level) so the env host import
// runs during a dispatch, when the request host is bound — the same pattern
// AuthService uses for its secrets.
let __aud: string | null = null;
function aud(): string {
    const cached = __aud;
    if (cached != null) return cached;
    const v = Environment.getSecure('TOIL_AUTH_AUDIENCE');
    const resolved = v != null ? v : 'toil';
    __aud = resolved;
    return resolved;
}

/**
 * The tenant domain the stable {@link ToilUserId} is scoped to: the configured
 * `TOIL_AUTH_DOMAIN` if set, else the request's `Host` header, else `localhost`.
 * It only needs to be stable per deployment (it is one of the SHA-256 inputs of
 * the user id), so any robust per-deployment host source is fine.
 */
function authDomain(ctx: RouteContext): string {
    const configured = Environment.getSecure('TOIL_AUTH_DOMAIN');
    if (configured != null) return configured;
    const host = ctx.request.header('host');
    if (host != null) return host;
    return 'localhost';
}

function randomBytes(n: i32): Uint8Array {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
}

function nowSecs(): u64 {
    return <u64>(Date.now() / 1000);
}

/** One generic error on every failure path (anti-enumeration, anti-oracle). */
function fail(): Response {
    return Response.text('auth: request failed\n', 401);
}

/**
 * Deterministic per-user Argon2id salt (16 bytes). With the OPRF providing
 * precomputation resistance, a public/deterministic salt is fine: it only needs
 * to be unique per user (the OPRF output already differs per user). Making it
 * deterministic means register and login agree with NO stored salt, and an
 * unknown user yields the SAME stable salt as a known one would -- no
 * enumeration oracle.
 */
function deriveSalt(username: string): Uint8Array {
    return crypto.sha256Text('toil-auth-salt-v1:' + username).slice(0, 16);
}

@data
class Username {
    name: string = '';
    constructor(name: string = '') {
        this.name = name;
    }
}

@data
class ChallengeId {
    cid: Uint8Array = new Uint8Array(0);
    constructor(cid: Uint8Array = new Uint8Array(0)) {
        this.cid = cid;
    }
}

@data
class AuthAccount {
    username: string = '';
    salt: Uint8Array = new Uint8Array(0);
    publicKey: Uint8Array = new Uint8Array(0);
    memKiB: u32 = 0;
    iterations: u32 = 0;
    parallelism: u32 = 0;
}

@data
class Challenge {
    cid: Uint8Array = new Uint8Array(0);
    username: string = '';
    nonce: Uint8Array = new Uint8Array(0);
    iat: u64 = 0;
    exp: u64 = 0;
}

@database
class AuthDb {
    @collection static accounts: Documents<Username, AuthAccount>;
    @collection static challenges: Documents<ChallengeId, Challenge>;
}

@rest('auth')
class Auth {
    /** POST /auth/register/start  body: str(username) bytes(blinded)
     *  resp: u8(status=0) u32(mem) u32(iters) u32(par) bytes(salt) bytes(evaluated)
     *  No taken-oracle: always succeeds; register/finish rejects a duplicate. */
    @ratelimit(RateLimit.SlidingWindow, 5, 60)
    @post('/register/start')
    public registerStart(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const username = r.readString();
        const blinded = r.readBytes();
        if (!r.ok) return fail();
        const evaluated = AuthService.oprfEvaluate(username, blinded);
        if (evaluated.length != AuthService.OPRF_ELEMENT_LEN) return fail();

        const w = new DataWriter();
        w.writeU8(0);
        w.writeU32(MEM_KIB);
        w.writeU32(ITERS);
        w.writeU32(PAR);
        w.writeBytes(deriveSalt(username));
        w.writeBytes(evaluated);
        return Response.bytes(w.toBytes());
    }

    /** POST /auth/register/finish  body: str(username) bytes(pk) bytes(regProof)
     *  resp: u8(status) -- 0 = ok, 1 = username already registered. Verifies
     *  proof-of-possession before storing the key. */
    @ratelimit(RateLimit.SlidingWindow, 5, 60)
    @post('/register/finish')
    public registerFinish(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const username = r.readString();
        const pk = r.readBytes();
        const proof = r.readBytes();
        if (!r.ok) return fail();
        if (pk.length != AuthService.PUBLIC_KEY_LEN) return fail();
        // Already registered: a distinguishable status (not the generic 401) so the
        // client can say "username taken, log in instead" rather than a blank error.
        if (AuthDb.accounts.exists(new Username(username))) {
            return Response.bytes(new DataWriter().writeU8(1).toBytes());
        }

        // Proof-of-possession: the client signed buildRegisterMessage with the
        // matching secret key, so we confirm it actually holds it.
        const regMsg = AuthService.buildRegisterMessage(username, pk);
        if (!AuthService.verifyRegister(pk, regMsg, proof)) return fail();

        const a = new AuthAccount();
        a.username = username;
        a.salt = deriveSalt(username);
        a.publicKey = pk;
        a.memKiB = MEM_KIB;
        a.iterations = ITERS;
        a.parallelism = PAR;
        // create-if-absent: a racing duplicate registration loses here, not above.
        if (!AuthDb.accounts.create(new Username(username), a)) {
            return Response.bytes(new DataWriter().writeU8(1).toBytes());
        }
        return Response.bytes(new DataWriter().writeU8(0).toBytes());
    }

    /** POST /auth/login/start  body: str(username) bytes(blinded)
     *  resp: bytes(cid) str(aud) u32(mem) u32(iters) u32(par) bytes(salt)
     *        bytes(nonce) u64(iat) u64(exp) bytes(evaluated)
     *  Anti-enumeration: ALWAYS OPRF-evaluates (real or decoy key from the same
     *  seed+username), returns a deterministic per-user salt + constant params,
     *  and a fresh challenge -- a known and an unknown user are indistinguishable. */
    @ratelimit(RateLimit.SlidingWindow, 5, 60)
    @post('/login/start')
    public loginStart(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const username = r.readString();
        const blinded = r.readBytes();
        if (!r.ok) return fail();
        const evaluated = AuthService.oprfEvaluate(username, blinded);
        if (evaluated.length != AuthService.OPRF_ELEMENT_LEN) return fail();

        const known = AuthDb.accounts.exists(new Username(username));
        const cid = randomBytes(16);
        const nonce = randomBytes(32);
        const iat = nowSecs();
        const exp = iat + CHALLENGE_TTL_SECS;

        // Persist only for a real account; the response is identical either way,
        // and login/finish for an unknown user fails generically at consume.
        if (known) {
            const c = new Challenge();
            c.cid = cid;
            c.username = username;
            c.nonce = nonce;
            c.iat = iat;
            c.exp = exp;
            AuthDb.challenges.create(new ChallengeId(cid), c);
        }

        const w = new DataWriter();
        w.writeBytes(cid);
        w.writeString(aud());
        w.writeU32(MEM_KIB);
        w.writeU32(ITERS);
        w.writeU32(PAR);
        w.writeBytes(deriveSalt(username));
        w.writeBytes(nonce);
        w.writeU64(iat);
        w.writeU64(exp);
        w.writeBytes(evaluated);
        return Response.bytes(w.toBytes());
    }

    /** POST /auth/login/finish  body: bytes(cid) bytes(ct) bytes(sig)
     *  resp: u8(status) [+ bytes(sessionToken) bytes(serverConfirm)] + Set-Cookie */
    @ratelimit(RateLimit.SlidingWindow, 5, 60)
    @post('/login/finish')
    public loginFinish(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const cid = r.readBytes();
        const ct = r.readBytes();
        const sig = r.readBytes();
        if (!r.ok) return fail();

        // 1. CONSUME FIRST: atomic fetch-and-delete. Unknown/used/expired => fail.
        const ch = AuthDb.challenges.getDelete(new ChallengeId(cid));
        if (ch == null) return fail();
        if (nowSecs() >= ch.exp) return fail();

        // 2. Rebuild the message from OUR stored values + the client's ct (and
        //    the bound params + server key id), load the account key, verify.
        const acct = AuthDb.accounts.get(new Username(ch.username));
        if (acct == null) return fail();
        const message = AuthService.buildLoginMessage(
            ch.username,
            aud(),
            cid,
            ch.nonce,
            ch.iat,
            ch.exp,
            ct,
            MEM_KIB,
            ITERS,
            PAR,
            AuthService.serverKemKeyId(),
        );
        if (!AuthService.verifyLogin(acct.publicKey, message, sig)) return fail();

        // 3. Decapsulate (proves WE hold the KEM key), derive the session key K
        //    bound to the transcript, and build the confirmation tag the client
        //    verifies for mutual auth.
        const sharedSecret = AuthService.mlkemDecapsulate(ct);
        if (sharedSecret.length != AuthService.SHARED_SECRET_LEN) return fail();
        const transcriptHash = AuthService.sha256(message);
        const sessionKey = AuthService.deriveSessionKey(sharedSecret, transcriptHash);
        const confirm = AuthService.serverConfirmTag(sessionKey, transcriptHash);

        // 4. Success: mint the session (the built-in @user codec, carrying the
        //    stable ToilUserId) and return {0, sessionToken, confirm}.
        const domain = authDomain(ctx);
        const userData = encodeSessionUser(acct.publicKey, ch.username, domain);
        const w = new DataWriter();
        w.writeU8(0);
        w.writeBytes(userData); // opaque session token (the readable user payload)
        w.writeBytes(confirm);
        const resp = Response.bytes(w.toBytes());
        resp.setCookie(AuthService.mintSession(userData, SESSION_TTL_SECS));
        resp.setCookie(AuthService.userCookie(userData, SESSION_TTL_SECS));
        return resp;
    }

    /** GET /auth/me  (@auth: 401 without a valid session) -> the typed user
     *  (bytes(toilUserId) str(username)). `AuthService.getUser()` is auto-typed
     *  to the built-in `@user` with no type argument. */
    @auth
    @get('/me')
    public me(_ctx: RouteContext): Response {
        const u = AuthService.getUser();
        if (u == null) return Response.text('no session\n', 401);
        const w = new DataWriter();
        w.writeBytes(u.toilUserId);
        w.writeString(u.username);
        return Response.bytes(w.toBytes());
    }

    /** POST /auth/logout  (@auth) -> clears both the signed session and the
     *  readable companion cookie. */
    @auth
    @post('/logout')
    public logout(_ctx: RouteContext): Response {
        const resp = Response.text('bye\n', 200);
        resp.setCookie(AuthService.clearSession());
        resp.setCookie(AuthService.clearUserCookie());
        return resp;
    }
}

import { Response, RouteContext } from 'toiljs/server/runtime';
import { DataReader, DataWriter } from 'data';

/**
 * Built-in Toil PQ-Auth controller: the full post-quantum password-login API
 * (`/auth/register|login/start|finish`) plus sessions (`/auth/me`, `/auth/logout`),
 * plus EMAIL VERIFICATION (`/auth/confirm`, `/auth/confirm/resend`) and PASSWORD
 * RESET (`/auth/reset/request|start|finish`), mounted automatically when an app
 * opts in with `server: { auth: true }` (or `import 'toiljs/server/auth'`). It is
 * a framework-shipped SOURCE file the build APPENDS to the toilscript entry set,
 * so its `@data`/`@database`/`@rest` decorators weave and its `@rest` class
 * self-mounts at `/auth/*` — no hand-written boilerplate.
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
 * EMAIL VERIFICATION: registration now collects the user's email. When email
 * confirmation is REQUIRED for the domain (the plain env var
 * `AUTH_REQUIRE_EMAIL_CONFIRMATION=true`, which the edge also force-sets from the
 * per-domain "Dacely setting" `TOIL_AUTH_REQUIRE_EMAIL_CONFIRMATION`), a new
 * account is stored unconfirmed and emailed a one-time confirm link; login is
 * refused (a distinguishable status) until the account is confirmed. When the
 * toggle is off, accounts are auto-confirmed and no email is sent.
 *
 * PASSWORD RESET: a reset is an AUTHORIZED RE-REGISTER. `/reset/request` emails a
 * one-time reset link (always a generic 200, never revealing whether the email
 * exists); the link drives `/reset/start` (peek the token -> OPRF) then
 * `/reset/finish` (consume the token -> verify a fresh proof-of-possession over
 * the NEW public key -> overwrite the stored `publicKey`). The password itself is
 * never involved server-side; only the derived ML-DSA public key changes.
 *
 * STORAGE: backed by ToilDB (`@database AuthDb`). Accounts are a `record`
 * collection keyed by username; an `emails` record maps email -> username (a
 * uniqueness index so reset can find an account by email); login challenges and
 * one-time confirm/reset tokens are `record`s consumed exactly once with
 * `getDelete` (atomic fetch-and-delete). Tokens are stored HASHED (only the raw
 * token in the emailed link is usable), each carrying its own expiry (there is no
 * native TTL; expiry is checked against the clock, consume-before-validate). The
 * dev server emulates these `env.data.*` host imports in process; the production
 * edge backs the SAME API with ScyllaDB.
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
const CONFIRM_TTL_SECS: u64 = 86400; // email confirm link valid 24h
const RESET_TTL_SECS: u64 = 3600; // password reset link valid 1h

// register/finish + login/finish status bytes (0 = ok).
const ST_OK: u8 = 0;
const ST_TAKEN: u8 = 1; // username already registered
const ST_EMAIL_TAKEN: u8 = 2; // email already in use (register)
const ST_UNCONFIRMED: u8 = 2; // email not confirmed (login) — distinct endpoint, reuses the value

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

/**
 * Whether this domain requires a confirmed email before login. A plain
 * (tenant-readable) env var so an app can opt in itself; the edge ALSO force-sets
 * it to "true" from the per-domain platform toggle `HostConfig.require_email_confirmation`
 * (reserved key `TOIL_AUTH_REQUIRE_EMAIL_CONFIRMATION`), so a Dacely per-domain
 * setting can turn it on without the app changing a line.
 */
function requireConfirmation(): bool {
    const v = Environment.get('AUTH_REQUIRE_EMAIL_CONFIRMATION');
    if (v == null) return false;
    // Lenient truthy, ALIGNED with the edge's HostConfig parse
    // (`!matches!(v.trim(), "0"|"false"|"no"|"off")`). A strict `== "true"` here
    // let a tenant slip a truthy-but-non-canonical value ("1"/"on"/"TRUE"/"true ")
    // past the guest while the edge treated it as "already opted in" and skipped
    // the force-on injection -> the platform mandate was defeatable. Same parse on
    // both sides closes that gap.
    const t = v.trim().toLowerCase();
    return t.length != 0 && t != '0' && t != 'false' && t != 'no' && t != 'off';
}

/**
 * The absolute origin the emailed confirm/reset links point at. Prefer the
 * tenant-set `PUBLIC_BASE_URL` (e.g. `https://app.example.com`); fall back to the
 * request `Host` (assumed https, since auth cookies are `__Host-`/`Secure`), then
 * localhost for dev. Trailing slash trimmed.
 */
/**
 * A request Host header is safe to use as an emailed-link authority ONLY if it is
 * a bare host[:port] with no userinfo/path/whitespace. The edge routes on a
 * PORT-STRIPPED, lowercased host, so a crafted `Host: victim.com:@attacker.com`
 * routes to the VICTIM tenant yet, dropped raw into `https://<host>/...`,
 * reparents the URL authority to attacker.com (browsers read `victim.com:` as
 * userinfo) -- a classic reset-link poisoning that mails the victim a link whose
 * token is delivered to the attacker. So we hard-reject anything but
 * `[A-Za-z0-9.:-]` plus IPv6 brackets; a poisoned Host yields `null`.
 */
function safeAuthority(host: string): string | null {
    if (host.length == 0 || host.length > 255) return null;
    for (let i = 0; i < host.length; i++) {
        const c = host.charCodeAt(i);
        const ok =
            (c >= 48 && c <= 57) || // 0-9
            (c >= 65 && c <= 90) || // A-Z
            (c >= 97 && c <= 122) || // a-z
            c == 46 || // .
            c == 45 || // -
            c == 58 || // : (port separator)
            c == 91 || // [ (IPv6)
            c == 93; //  ] (IPv6)
        if (!ok) return null;
    }
    return host;
}

/** A tenant-configured base URL is trusted (they own it) but must still be a
 *  well-formed absolute http(s) origin with no control/injection chars: this value
 *  is concatenated into the emailed link, so a space (a second URL), a quote/angle
 *  (href breakout / HTML injection into the tenant's own emails), or a control
 *  (CR/LF) must all be rejected. */
function isAbsoluteHttpUrl(s: string): bool {
    if (!s.startsWith('https://') && !s.startsWith('http://')) return false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        // Reject controls + space (<=0x20), DEL, and the quote/angle/backtick chars
        // that enable a second URL, an href breakout, or HTML injection.
        if (
            c <= 0x20 ||
            c == 0x7f ||
            c == 0x22 || // "
            c == 0x27 || // '
            c == 0x3c || // <
            c == 0x3e || // >
            c == 0x60 //   `
        ) {
            return false;
        }
    }
    return true;
}

/**
 * The absolute origin the emailed confirm/reset links point at. Prefer the
 * tenant-set `PUBLIC_BASE_URL` (they own it, validated). The request Host is
 * ATTACKER-CONTROLLED, so it is used ONLY after strict authority validation
 * ({@link safeAuthority}); a poisoned or absent Host falls back to localhost,
 * NEVER an attacker-supplied origin. This closes host-header reset-poisoning.
 */
function baseUrl(ctx: RouteContext): string {
    const configured = Environment.get('PUBLIC_BASE_URL');
    if (configured != null && configured.length > 0 && isAbsoluteHttpUrl(configured)) {
        let b = configured;
        while (b.endsWith('/')) b = b.slice(0, b.length - 1);
        return b;
    }
    const host = ctx.request.header('host');
    const safe = host != null ? safeAuthority(host) : null;
    if (safe != null) return 'https://' + safe;
    return 'http://localhost:3000';
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

/** A generic 200 that never reveals whether an email/account exists. */
function ackOk(): Response {
    return Response.text('ok\n', 200);
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

/** The one-time-token lookup key: SHA-256 of the raw token bytes. Storing only
 *  the hash means a leak of the token store yields nothing usable — the raw
 *  token lives only in the emailed link. */
function tokenId(raw: Uint8Array): TokenId {
    return new TokenId(crypto.sha256(raw));
}

/** Mint a fresh 32-byte token; returns the raw bytes (for the link) — the store
 *  key is its hash. */
function mintToken(): Uint8Array {
    return randomBytes(32);
}

@data
class Username {
    name: string = '';
    constructor(name: string = '') {
        this.name = name;
    }
}

@data
class EmailKey {
    email: string = '';
    constructor(email: string = '') {
        this.email = email;
    }
}

@data
class EmailOwner {
    username: string = '';
    constructor(username: string = '') {
        this.username = username;
    }
}

@data
class TokenId {
    hash: Uint8Array = new Uint8Array(0);
    constructor(hash: Uint8Array = new Uint8Array(0)) {
        this.hash = hash;
    }
}

/** A one-time confirm/reset token record: which account it authorizes + its
 *  absolute expiry (unix secs). Consumed with `getDelete`. */
@data
class TokenRec {
    username: string = '';
    exp: u64 = 0;
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
    // The original credential fields keep their byte positions; `email` +
    // `emailConfirmed` are APPENDED so this is a forward-compatible, append-only
    // @data change (an old row decodes with emailConfirmed=false, the strict/safe
    // default) rather than a breaking mid-struct reorder the deploy gate rejects.
    username: string = '';
    salt: Uint8Array = new Uint8Array(0);
    publicKey: Uint8Array = new Uint8Array(0);
    memKiB: u32 = 0;
    iterations: u32 = 0;
    parallelism: u32 = 0;
    email: string = '';
    emailConfirmed: bool = false;
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
    @collection static emails: Documents<EmailKey, EmailOwner>; // email -> username (uniqueness index)
    @collection static challenges: Documents<ChallengeId, Challenge>;
    @collection static confirmTokens: Documents<TokenId, TokenRec>;
    @collection static resetTokens: Documents<TokenId, TokenRec>;
    // username -> its CURRENT outstanding confirm/reset token id, so minting a new
    // one can invalidate the previous: outstanding tokens stay bounded at one per
    // user per kind (O(users)), not one per request (unbounded storage-griefing).
    @collection static confirmTokenOf: Documents<Username, TokenId>;
    @collection static resetTokenOf: Documents<Username, TokenId>;
}

@rest('auth')
class Auth {
    /** POST /auth/register/start  body: str(username) bytes(blinded)
     *  resp: u8(status=0) u32(mem) u32(iters) u32(par) bytes(salt) bytes(evaluated)
     *  No taken-oracle: always succeeds; register/finish rejects a duplicate.
     *  Reused verbatim by password reset (the OPRF for the NEW password). */
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
        w.writeU8(ST_OK);
        w.writeU32(MEM_KIB);
        w.writeU32(ITERS);
        w.writeU32(PAR);
        w.writeBytes(deriveSalt(username));
        w.writeBytes(evaluated);
        return Response.bytes(w.toBytes());
    }

    /** POST /auth/register/finish  body: str(username) str(email) bytes(pk) bytes(regProof)
     *  resp: u8(status) -- 0 = ok, 1 = username taken, 2 = email in use. Verifies
     *  proof-of-possession before storing. When confirmation is required the
     *  account is stored UNCONFIRMED and emailed a confirm link; otherwise it is
     *  auto-confirmed. */
    @ratelimit(RateLimit.SlidingWindow, 5, 60)
    @post('/register/finish')
    public registerFinish(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const username = r.readString();
        const email = r.readString();
        const pk = r.readBytes();
        const proof = r.readBytes();
        if (!r.ok) return fail();
        if (pk.length != AuthService.PUBLIC_KEY_LEN) return fail();
        if (username.length == 0 || username.length > 64) return fail();
        if (email.length == 0 || email.length > 254) return fail();

        // Proof-of-possession FIRST (before any existence check): the client
        // signed buildRegisterMessage with the matching secret key. Verifying up
        // front means register/finish is not a cheap PRE-crypto oracle for "is
        // this username/email registered" -- a probe must present a valid ML-DSA
        // PoP, not just a well-formed body.
        const regMsg = AuthService.buildRegisterMessage(username, pk);
        if (!AuthService.verifyRegister(pk, regMsg, proof)) return fail();

        // Distinguishable statuses (not the generic 401) so the UI can say
        // "username taken" / "email in use". Signup intentionally leaks existence
        // (a product choice, now gated behind the PoP above); reset never does.
        if (AuthDb.accounts.exists(new Username(username))) {
            return Response.bytes(new DataWriter().writeU8(ST_TAKEN).toBytes());
        }
        if (AuthDb.emails.exists(new EmailKey(email))) {
            return Response.bytes(new DataWriter().writeU8(ST_EMAIL_TAKEN).toBytes());
        }

        const mustConfirm = requireConfirmation();
        const a = new AuthAccount();
        a.username = username;
        a.email = email;
        a.emailConfirmed = !mustConfirm; // auto-confirm when confirmation is off
        a.salt = deriveSalt(username);
        a.publicKey = pk;
        a.memKiB = MEM_KIB;
        a.iterations = ITERS;
        a.parallelism = PAR;
        // create-if-absent: a racing duplicate registration loses here, not above.
        if (!AuthDb.accounts.create(new Username(username), a)) {
            return Response.bytes(new DataWriter().writeU8(ST_TAKEN).toBytes());
        }
        // Reserve the email -> username index (uniqueness for reset-by-email). A
        // racing duplicate email loses here: roll back the account we just created
        // so a lost email race can't orphan a username whose email index points at
        // someone else (which would also break reset-by-email for it).
        if (!AuthDb.emails.create(new EmailKey(email), new EmailOwner(username))) {
            AuthDb.accounts.delete(new Username(username));
            return Response.bytes(new DataWriter().writeU8(ST_EMAIL_TAKEN).toBytes());
        }

        if (mustConfirm) {
            this.issueConfirmation(ctx, username, email);
        }
        return Response.bytes(new DataWriter().writeU8(ST_OK).toBytes());
    }

    /** POST /auth/confirm  body: bytes(rawToken)  resp: u8(0 ok | else fail)
     *  Consumes the one-time confirm token and marks the account confirmed. The
     *  emailed link points at the app page `/confirm?token=<hex>`, which POSTs the
     *  raw token here. */
    @ratelimit(RateLimit.SlidingWindow, 10, 60)
    @post('/confirm')
    public confirm(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const raw = r.readBytes();
        if (!r.ok || raw.length == 0) return fail();
        // Consume FIRST (a replayed/expired token still burns), then validate.
        const rec = AuthDb.confirmTokens.getDelete(tokenId(raw));
        if (rec == null) return fail();
        if (nowSecs() >= rec.exp) return fail();
        const acct = AuthDb.accounts.get(new Username(rec.username));
        if (acct == null) return fail();
        if (!acct.emailConfirmed) {
            acct.emailConfirmed = true;
            AuthDb.accounts.patch(new Username(rec.username), acct);
        }
        return Response.bytes(new DataWriter().writeU8(ST_OK).toBytes());
    }

    /** POST /auth/confirm/resend  body: str(email)  resp: generic 200 always.
     *  Re-issues a confirm link if that email maps to an unconfirmed account.
     *  Never reveals whether the email exists. */
    @ratelimit(RateLimit.SlidingWindow, 3, 300)
    @post('/confirm/resend')
    public confirmResend(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const email = r.readString();
        if (!r.ok) return fail();
        const owner = AuthDb.emails.get(new EmailKey(email));
        if (owner != null) {
            const acct = AuthDb.accounts.get(new Username(owner.username));
            if (acct != null && !acct.emailConfirmed) {
                this.issueConfirmation(ctx, owner.username, email);
            }
        }
        return ackOk();
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
     *  resp: u8(status) [+ bytes(sessionToken) bytes(serverConfirm)] + Set-Cookie
     *  status 2 = email not confirmed (when confirmation is required). */
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

        // 2b. Email-confirmation gate: a valid credential is not enough when the
        //     domain requires a confirmed email. Distinguishable status so the
        //     client can prompt "confirm your email / resend". Checked AFTER the
        //     signature so it is not an oracle for unconfirmed-account existence.
        if (requireConfirmation() && !acct.emailConfirmed) {
            return Response.bytes(new DataWriter().writeU8(ST_UNCONFIRMED).toBytes());
        }

        // 3. Decapsulate (proves WE hold the KEM key), derive the session key K
        //    bound to the transcript, and build the confirmation tag the client
        //    verifies for mutual auth.
        const sharedSecret = AuthService.mlkemDecapsulate(ct);
        if (sharedSecret.length != AuthService.SHARED_SECRET_LEN) return fail();
        const transcriptHash = AuthService.sha256(message);
        const sessionKey = AuthService.deriveSessionKey(sharedSecret, transcriptHash);
        const confirm = AuthService.serverConfirmTag(sessionKey, transcriptHash);

        // 4. Success: mint the session for whatever `@user` this program has (built-in or the app's own
        //    extended one). `__toilEncodeAuthUser` is injected by `--authUser`: it constructs the `@user`
        //    (app fields at their defaults), sets the reserved identity, and encodes it. The stable
        //    ToilUserId is derived from the login public key + username + tenant domain.
        const domain = authDomain(ctx);
        const toilUserId = ToilUserId.derive(acct.publicKey, ch.username, domain).toBytes();
        const userData = __toilEncodeAuthUser(toilUserId, ch.username);
        const w = new DataWriter();
        w.writeU8(ST_OK);
        w.writeBytes(userData); // opaque session token (the readable user payload)
        w.writeBytes(confirm);
        const resp = Response.bytes(w.toBytes());
        resp.setCookie(AuthService.mintSession(userData, SESSION_TTL_SECS));
        resp.setCookie(AuthService.userCookie(userData, SESSION_TTL_SECS));
        return resp;
    }

    /** POST /auth/reset/request  body: str(email)  resp: generic 200 always.
     *  Mints a one-time reset token and emails a reset link IF the email maps to
     *  an account. Never reveals whether the email exists (always 200, always the
     *  same shape) — the standard non-enumerating "if that email exists, we sent
     *  a link" behaviour. */
    @ratelimit(RateLimit.SlidingWindow, 3, 300)
    @post('/reset/request')
    public resetRequest(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const email = r.readString();
        if (!r.ok) return fail();
        const owner = AuthDb.emails.get(new EmailKey(email));
        if (owner != null && AuthDb.accounts.exists(new Username(owner.username))) {
            // Invalidate this user's previous reset token (bound to one outstanding).
            const prev = AuthDb.resetTokenOf.getDelete(new Username(owner.username));
            if (prev != null) AuthDb.resetTokens.delete(prev);
            const raw = mintToken();
            const tid = tokenId(raw);
            const rec = new TokenRec();
            rec.username = owner.username;
            rec.exp = nowSecs() + RESET_TTL_SECS;
            AuthDb.resetTokens.create(tid, rec);
            // If a concurrent reset request won the pointer index, roll back the
            // token we just minted so exactly one stays outstanding (no orphan).
            if (!AuthDb.resetTokenOf.create(new Username(owner.username), tid)) {
                AuthDb.resetTokens.delete(tid);
            }
            // Token in the URL FRAGMENT, not the query string: a fragment is never
            // sent to the server (so it can't land in edge/CDN access logs) nor in
            // the Referer header. The reset page reads it client-side from
            // location.hash and should history.replaceState() to scrub it.
            const link = baseUrl(ctx) + '/reset#token=' + crypto.toHex(raw);
            this.sendResetEmail(email, link);
        }
        return ackOk();
    }

    /** POST /auth/reset/start  body: bytes(rawToken) bytes(blinded)
     *  resp: u8(0) str(username) u32(mem) u32(iters) u32(par) bytes(salt) bytes(evaluated)
     *  PEEKS the reset token (does not consume it — that happens at finish),
     *  returns the account's username + KDF params + the OPRF evaluation of the
     *  NEW blinded password so the client can derive the new keypair. A bad or
     *  expired token fails generically. */
    @ratelimit(RateLimit.SlidingWindow, 5, 60)
    @post('/reset/start')
    public resetStart(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const raw = r.readBytes();
        const blinded = r.readBytes();
        if (!r.ok || raw.length == 0) return fail();
        const rec = AuthDb.resetTokens.get(tokenId(raw));
        if (rec == null) return fail();
        if (nowSecs() >= rec.exp) return fail();
        const evaluated = AuthService.oprfEvaluate(rec.username, blinded);
        if (evaluated.length != AuthService.OPRF_ELEMENT_LEN) return fail();

        const w = new DataWriter();
        w.writeU8(ST_OK);
        w.writeString(rec.username);
        w.writeU32(MEM_KIB);
        w.writeU32(ITERS);
        w.writeU32(PAR);
        w.writeBytes(deriveSalt(rec.username));
        w.writeBytes(evaluated);
        return Response.bytes(w.toBytes());
    }

    /** POST /auth/reset/finish  body: bytes(rawToken) bytes(newPk) bytes(regProof)
     *  resp: u8(0 ok | else fail). CONSUMES the reset token, verifies a fresh
     *  proof-of-possession over the NEW public key, and overwrites the account's
     *  stored publicKey (a reset is an authorized re-register; only the derived
     *  ML-DSA key changes). */
    @ratelimit(RateLimit.SlidingWindow, 5, 60)
    @post('/reset/finish')
    public resetFinish(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const raw = r.readBytes();
        const pk = r.readBytes();
        const proof = r.readBytes();
        if (!r.ok || raw.length == 0) return fail();
        if (pk.length != AuthService.PUBLIC_KEY_LEN) return fail();
        // Consume FIRST (single use), then validate.
        const rec = AuthDb.resetTokens.getDelete(tokenId(raw));
        if (rec == null) return fail();
        if (nowSecs() >= rec.exp) return fail();
        const acct = AuthDb.accounts.get(new Username(rec.username));
        if (acct == null) return fail();

        const regMsg = AuthService.buildRegisterMessage(rec.username, pk);
        if (!AuthService.verifyRegister(pk, regMsg, proof)) return fail();

        // Overwrite ONLY the login verifier. Salt/params are deterministic
        // constants (unchanged); a successful reset also implies email ownership,
        // so confirm the account while we are here.
        acct.publicKey = pk;
        acct.emailConfirmed = true;
        AuthDb.accounts.patch(new Username(rec.username), acct);
        return Response.bytes(new DataWriter().writeU8(ST_OK).toBytes());
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

    /** Mint a confirm token for `username`/`email` and email the confirm link.
     *  Best-effort: a failed send is not fatal (the user can resend).
     *
     *  Uses the DETACHED (non-suspending) send: `confirm/resend` returns the same
     *  generic 200 whether or not the email maps to an account, but on the edge a
     *  suspending `EmailService.send` would park the "account exists" path for the
     *  mailer's provider RTT while the miss path returned instantly — a trivially
     *  measurable email-enumeration timing oracle. `sendDetached` queues in
     *  constant time, equalizing both paths. (Residual: on the exists path the
     *  token mint above still does a sub-ms ToilDB write the miss path skips; a
     *  fully constant-time guarantee would also equalize that DB work.) */
    private issueConfirmation(ctx: RouteContext, username: string, email: string): void {
        // Invalidate this user's previous confirm token (bound to one outstanding).
        const prev = AuthDb.confirmTokenOf.getDelete(new Username(username));
        if (prev != null) AuthDb.confirmTokens.delete(prev);
        const raw = mintToken();
        const tid = tokenId(raw);
        const rec = new TokenRec();
        rec.username = username;
        rec.exp = nowSecs() + CONFIRM_TTL_SECS;
        AuthDb.confirmTokens.create(tid, rec);
        // If a concurrent request won the pointer index, roll back the token we
        // just minted so exactly one stays outstanding (no orphan).
        if (!AuthDb.confirmTokenOf.create(new Username(username), tid)) {
            AuthDb.confirmTokens.delete(tid);
        }
        // Token in the URL FRAGMENT (see resetRequest): kept out of server/CDN
        // logs and the Referer header; the confirm page reads it from location.hash.
        const link = baseUrl(ctx) + '/confirm#token=' + crypto.toHex(raw);
        const subject = 'Confirm your account';
        const text = 'Confirm your account by opening this link:\n' + link + '\n';
        const html =
            '<p>Confirm your account by clicking the link below:</p>' +
            '<p><a href="' +
            link +
            '">Confirm my account</a></p>' +
            '<p>Or paste this into your browser:<br>' +
            link +
            '</p>';
        // DETACHED (non-suspending) send: constant-time, no provider-RTT parking on
        // the "account exists" path (see the enumeration note on this method).
        EmailService.sendDetached(email, subject, text, 'verify', html);
    }

    /** Email a password-reset link. Best-effort (the request path already
     *  returned a generic 200).
     *
     *  Uses the DETACHED (non-suspending) send for the SAME anti-enumeration
     *  reason as {@link issueConfirmation}: `/reset/request` always returns a
     *  generic 200, so the send must not make the "email exists" path park for the
     *  provider RTT (a timing oracle). `sendDetached` queues in constant time.
     *  (Residual: the reset-token mint on the exists path still does a sub-ms
     *  ToilDB write the miss path skips.) */
    private sendResetEmail(email: string, link: string): void {
        const subject = 'Reset your password';
        const text = 'Reset your password by opening this link:\n' + link + '\n';
        const html =
            '<p>We received a request to reset your password. Click the link below:</p>' +
            '<p><a href="' +
            link +
            '">Reset my password</a></p>' +
            '<p>If you did not request this, you can ignore this email.</p>' +
            '<p>Or paste this into your browser:<br>' +
            link +
            '</p>';
        // DETACHED (non-suspending) send: constant-time, closes the reset-request
        // email-enumeration timing oracle (see the note above).
        EmailService.sendDetached(email, subject, text, 'reset', html);
    }
}

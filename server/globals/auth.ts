// AuthService: the server half of the post-quantum auth primitive, available
// as a no-import global (registered via the toilscript `--lib` mechanism, the
// same way `crypto` is a global). The client derives an ML-DSA-44 keypair from
// the password (Argon2id), keeps the public key on the account, and signs a
// login challenge; the server rebuilds the exact signed message from its OWN
// stored values and verifies the signature here.
//
// Crypto is verify-only on the server: the host never holds a secret. Backed by
// the `crypto.mldsa_verify` host import (toil-backend `mldsa_verify_import.rs`,
// and the toiljs dev-server mock).

import { DataWriter, DataReader } from 'data';

import {
    Server,
    SecureCookies,
    Cookie,
    SameSite,
    Time,
    base64UrlEncode,
    base64UrlDecode,
} from 'toiljs/server/runtime';

// Host import: ML-DSA-44 (FIPS 204) verify. Returns 1 (valid), 0 (invalid), or
// a negative error code. The keypair is client-derived; only public material
// crosses this boundary.
// @ts-ignore: decorator
@external('env', 'crypto.mldsa_verify')
declare function __toilMldsaVerify(
    pkPtr: usize,
    pkLen: i32,
    msgPtr: usize,
    msgLen: i32,
    sigPtr: usize,
    sigLen: i32,
    ctxPtr: usize,
    ctxLen: i32,
): i32;

// HMAC key for signing session cookies. The SAME secret must be configured on
// every edge instance (a sealed cookie minted by one is opened by another) and
// must NEVER reach the client. There is no host-config secret mechanism yet, so
// the tenant supplies one at startup via `AuthService.setSecret(...)` (a
// build-time constant is consistent across instances). The default below is a
// well-known DEV placeholder: a deployment that does not call `setSecret` gets a
// loud, insecure-but-functional session so local dev works out of the box.
// TODO(secret): replace with a per-deployment host-config secret.
let __sessionSecret: Uint8Array = Uint8Array.wrap(
    String.UTF8.encode('toil-dev-insecure-session-secret-CHANGE-ME'),
);

// Whether the current request arrived over HTTPS. A TLS edge / proxy signals it
// with `x-forwarded-proto: https`; absent (plain HTTP, including `toiljs dev`)
// the session uses plain cookies so they actually round-trip in the browser.
// Over HTTPS the cookies keep their hardened `__Host-`/`__Secure-` prefixes and
// the `Secure` flag. The signature + expiry checks are identical either way.
function __reqIsSecure(): bool {
    const req = Server.currentRequest;
    if (req == null) return false;
    const proto = req.header('x-forwarded-proto');
    return proto != null && proto == 'https';
}

export namespace AuthService {
    /** Signed session cookie name (the HTTPS form). `__Host-` pairs with
     *  `asHostPrefixed()` (Secure, Path=/, no Domain) for the strongest browser
     *  scoping; over plain HTTP the unprefixed `toil_sess` is used instead. */
    export const SESSION_COOKIE: string = '__Host-toil_sess';

    /** Base (unprefixed) cookie names; the `__Host-`/`__Secure-` prefixes are
     *  added only when the request is secure (see `__reqIsSecure`). */
    const SESSION_BASE: string = 'toil_sess';
    const USER_BASE: string = 'toil_user';

    /** The session / companion cookie name actually used for `secure`. */
    function sessionCookieName(secure: bool): string {
        return secure ? '__Host-' + SESSION_BASE : SESSION_BASE;
    }
    function userCookieName(secure: bool): string {
        return secure ? '__Secure-' + USER_BASE : USER_BASE;
    }

    /** Session payload format version (first byte of the sealed payload). */
    const SESSION_VERSION: u8 = 1;

    /** Default session lifetime if `mintSession` is called without a ttl. */
    export const DEFAULT_SESSION_TTL_SECS: u64 = 86400; // 24h

    /**
     * Configure the server secret used to sign session cookies. Call once at
     * startup from the tenant's `main.ts`. Must be identical on every edge
     * instance and kept out of any client bundle.
     */
    export function setSecret(secret: Uint8Array): void {
        __sessionSecret = secret;
    }

    /**
     * The verified session payload (the `@user` codec bytes) for the current
     * request, or `null` if there is no session, the signature does not verify,
     * or it has expired. Reads the ambient request's cookies (no argument), so
     * it is only meaningful during a dispatch.
     */
    export function getSessionBytes(): Uint8Array | null {
        const req = Server.currentRequest;
        if (req == null) return null;

        const sealed = SecureCookies.signed(__sessionSecret).open(
            req.cookies(),
            sessionCookieName(__reqIsSecure()),
        );
        if (sealed == null) return null;

        const payload = base64UrlDecode(sealed);
        if (payload == null) return null;

        const r = new DataReader(payload);
        if (r.readU8() != SESSION_VERSION) return null; // version
        r.readU64();                                     // iat (unused on read)
        const exp = r.readU64();
        const userBytes = r.readBytes();
        if (!r.ok) return null;                          // truncated/malformed

        if (Time.nowSeconds() >= exp) return null;       // expired

        return userBytes;
    }

    /** Whether the current request carries a valid, unexpired session. The
     *  toilscript `@auth` guard calls this before running the route. */
    export function hasSession(): bool {
        return getSessionBytes() != null;
    }

    /**
     * The authenticated user for the current request, decoded from the verified
     * session, or `null`. Auto-typed to the tenant's `@user` class with NO type
     * argument: the toilscript `@user` transform injects a `@global` subclass
     * `AuthUser extends <YourUser>` and a `__toilDecodeAuthUser` decoder, so this
     * returns the user's own fields. Tenants without a `@user` class never call
     * this, so AssemblyScript skips compiling it (the injected globals are
     * absent there, which is fine).
     */
    // @ts-ignore: AuthUser / __toilDecodeAuthUser are injected by the @user transform
    export function getUser(): AuthUser | null {
        const bytes = getSessionBytes();
        // @ts-ignore: __toilDecodeAuthUser is injected by the @user transform
        return bytes == null ? null : __toilDecodeAuthUser(bytes);
    }

    /**
     * Mint a signed session cookie carrying `userData` (the `@user` codec bytes,
     * i.e. `myUser.encode()`), valid for `ttlSecs`. Set it on the response with
     * `Response.setCookie(...)`. HMAC-signed, HttpOnly, Secure, SameSite=Lax,
     * `__Host-` scoped. The value stays readable but cannot be forged or moved.
     */
    export function mintSession(userData: Uint8Array, ttlSecs: u64 = DEFAULT_SESSION_TTL_SECS): Cookie {
        const now = Time.nowSeconds();
        const w = new DataWriter();
        w.writeU8(SESSION_VERSION);
        w.writeU64(now);
        w.writeU64(now + ttlSecs);
        w.writeBytes(userData);

        const secure = __reqIsSecure();
        let cookie = Cookie.create(SESSION_BASE, base64UrlEncode(w.toBytes()))
            .httpOnly()
            .sameSite(SameSite.Lax)
            .maxAge(<i64>ttlSecs);
        cookie = secure ? cookie.asHostPrefixed() : cookie.path('/');
        return SecureCookies.signed(__sessionSecret).seal(cookie);
    }

    /** A `Set-Cookie` that immediately clears the session (logout). */
    export function clearSession(): Cookie {
        const secure = __reqIsSecure();
        let cookie = Cookie.create(SESSION_BASE, '')
            .httpOnly()
            .sameSite(SameSite.Lax)
            .maxAge(0);
        cookie = secure ? cookie.asHostPrefixed() : cookie.path('/');
        return cookie;
    }

    /** Readable companion cookie name: a NON-HttpOnly copy of the user data for
     *  the client's `getUser()` to display. UNTRUSTED: the server always
     *  re-verifies the signed session and never reads this; treat it as
     *  display-only (a client can forge it, but only fools its own UI). */
    export const USER_COOKIE: string = '__Secure-toil_user';

    /**
     * A readable companion cookie carrying `userData` (the `@user` codec bytes,
     * base64url) for the client. Secure + SameSite=Lax but NOT HttpOnly, so the
     * browser exposes it to `document.cookie`. Set it alongside
     * {@link mintSession}; the server NEVER trusts it.
     */
    export function userCookie(userData: Uint8Array, ttlSecs: u64 = DEFAULT_SESSION_TTL_SECS): Cookie {
        const secure = __reqIsSecure();
        let cookie = Cookie.create(USER_BASE, base64UrlEncode(userData))
            .sameSite(SameSite.Lax)
            .maxAge(<i64>ttlSecs);
        cookie = secure ? cookie.asSecurePrefixed() : cookie.path('/');
        return cookie;
    }

    /** A `Set-Cookie` that clears the readable companion cookie (logout). */
    export function clearUserCookie(): Cookie {
        const secure = __reqIsSecure();
        let cookie = Cookie.create(USER_BASE, '')
            .sameSite(SameSite.Lax)
            .maxAge(0);
        cookie = secure ? cookie.asSecurePrefixed() : cookie.path('/');
        return cookie;
    }

    /** FIPS 204 signing context (domain separator) for login. Byte-identical
     *  on the client signer and this verifier; binds a signature to "login" so
     *  it can never validate against another operation reusing the keypair. */
    export const LOGIN_CONTEXT: string = 'qauth:login:v1';

    /** ML-DSA-44 (FIPS 204, security level 2) fixed sizes. */
    export const PUBLIC_KEY_LEN: i32 = 1312;
    export const SIGNATURE_LEN: i32 = 2420;

    /**
     * Build the canonical login message `M` the client signs and the server
     * verifies, with a FIXED binary layout (no JSON). The server MUST call this
     * with its OWN stored values, never with fields echoed by the client. Both
     * ends use this exact field order via the byte-identical `DataWriter`:
     *
     *   u8  version = 1
     *   str sub      (username; u32-LE len + UTF-8)
     *   str aud      (this service's audience; server-config constant)
     *   bytes cid    (challenge id; u32-LE len + raw)
     *   bytes nonce  (32 random bytes; u32-LE len + raw)
     *   u64 iat      (issued-at, seconds, LE)
     *   u64 exp      (expiry, seconds, LE)
     */
    export function buildLoginMessage(
        sub: string,
        aud: string,
        cid: Uint8Array,
        nonce: Uint8Array,
        iat: u64,
        exp: u64,
    ): Uint8Array {
        const w = new DataWriter();
        w.writeU8(1);
        w.writeString(sub);
        w.writeString(aud);
        w.writeBytes(cid);
        w.writeBytes(nonce);
        w.writeU64(iat);
        w.writeU64(exp);
        return w.toBytes();
    }

    /**
     * Verify a login signature over `message` against the account's stored
     * `publicKey`, under {@link LOGIN_CONTEXT}. Fail-closed on any size
     * mismatch. `message` should be the output of {@link buildLoginMessage}
     * rebuilt from server-held values.
     */
    export function verifyLogin(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): bool {
        if (publicKey.length != PUBLIC_KEY_LEN || signature.length != SIGNATURE_LEN) {
            return false;
        }
        const ctx = Uint8Array.wrap(String.UTF8.encode(LOGIN_CONTEXT));
        const result = __toilMldsaVerify(
            publicKey.dataStart,
            publicKey.length,
            message.dataStart,
            message.length,
            signature.dataStart,
            signature.length,
            ctx.dataStart,
            ctx.length,
        );
        return result == 1;
    }
}

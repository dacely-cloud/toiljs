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
import { HmacImportParams, HmacParams, ALG_SHA_256, USAGE_SIGN, USAGE_VERIFY } from 'crypto';

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

// Host import: ML-KEM-768 (FIPS 203) decapsulation. Recovers the 32-byte shared
// secret from the client's ciphertext using the server static secret key,
// written to `outPtr`. Returns 0 on success, negative on error. The secret key
// is the server's own identity key (NOT password-derived), configured at
// startup and passed per call; the host never stores it.
// @ts-ignore: decorator
@external('env', 'crypto.mlkem_decapsulate')
declare function __toilMlkemDecapsulate(
    ctPtr: usize,
    ctLen: i32,
    skPtr: usize,
    skLen: i32,
    outPtr: usize,
): i32;

// Host import: RFC 9497 OPRF (mode 0x00, ristretto255-SHA512) server evaluation.
// Derives the per-user key from (seed, info=username) and blind-evaluates the
// client's blinded element, writing the 32-byte evaluated element to `outPtr`.
// Returns 0 on success, negative on error. `seed` is the server's secret OPRF
// master seed, configured at startup and passed per call.
// @ts-ignore: decorator
@external('env', 'crypto.voprf_evaluate')
declare function __toilVoprfEvaluate(
    seedPtr: usize,
    seedLen: i32,
    infoPtr: usize,
    infoLen: i32,
    blindedPtr: usize,
    blindedLen: i32,
    outPtr: usize,
): i32;

// Secret configuration is AUTOMATIC. Every secret below resolves on first use
// from, in order: (1) an explicit `set*()` override, (2) the tenant's env store
// (`Environment.getSecure`, backed by `.env.secrets` / the dashboard) under the
// key named below, then (3) a well-known, clearly-insecure DEV fallback so local
// dev and the examples run with zero config. The resolved value is cached in the
// module global. Because every request runs in a FRESH wasm instance that reads
// the SAME env value the SAME way, there is no per-route / per-instance secret to
// keep in sync by hand: a cookie minted by one route can never fail to verify in
// another for want of a `setSecret` call. A real deployment sets the env values
// (and pins its own server KEM public key in the client); the DEV fallbacks are
// never a place to put a real secret.

/** Env-store keys the framework reads automatically (tenant-set secrets). */
const ENV_SESSION_SECRET: string = 'AUTH_SESSION_SECRET';
const ENV_OPRF_SEED: string = 'AUTH_OPRF_SEED';
const ENV_KEM_SK: string = 'AUTH_KEM_SK';

/** Well-known DEV fallbacks (insecure; overridden by env or `set*()`). */
const DEV_SESSION_SECRET: string = 'toil-dev-insecure-session-secret-CHANGE-ME';
const DEV_OPRF_SEED_SRC: string = 'toil-dev-oprf-seed-v1';
// A well-known DEV ML-KEM-768 decapsulation key (hex). Its public half (the `ek`
// at bytes [1152, 2336) of the dk) is PINNED in the client (`src/client/auth.ts`,
// `SERVER_KEM_PUBLIC_KEY`), so the PQ-auth example runs with zero config. A real
// deployment sets `AUTH_KEM_SK` and pins its own public key; never treat this as
// secret. Tree-shaken away unless a server actually calls the ML-KEM path.
const DEV_KEM_SK_HEX: string = '3156a8eb11c62bdb4af9fc57bef470f880ae340373bcc61662748a9742a639b9ad6bc55a77a82e0caa99ede237b4783ce70ab08ecc5802a9478c4ca3de67acd7a2147db43fdba408e9765443f37e9e90cc09f836d53879b890126bd6c33d55a6d97636a28ba10e18ac919aa9d37c2e4d07b6c930a5cb3238c8338fbb1abe7dac124c93462ebc5ae81cb132947993a74f9602610eab68b7fc9407b58e958aca054443246240c484c650962408168632c303cfc738d3b918ee04a37c2436b6f7300b8c6e7bd528bc5c229673c3a1bc4ae4265772f654ed8377b285626c67a4ef715a5a04a56804c3fae93ca5e3219cd68649622ee0d77bcb664a68e377260a3a38c2739b81c3c9ec510b66acde5041f3b52922a17019dc9afaec71c3e3c3102686ceb019da138b22463ad7f452640526d1d8b21c9111ca844149d1391c937b84287f1a228342c06ccb87c31cb14227e175007c5c4497c11e8647377234a84ab2640aa8ee7acb54954f99155cf7d768446b104ac149f59ca1d0029401570db9341c93db0041d52fbbd62726a75f9ab177e4ea5176e675d28a1f9852c28b38074c91cec8064b6ba116db8b59c0434fbd1b207cd921fbf29b06740b53c7304b17b253652ad469b2cb10bf7ed3bcc5b1b6168c2d30a889f67a01ae79455100ac582ba2f764a4a4b134b9115d7c548032d55d4916ce25c0ce7c42160e446298fb10f747302e781a70b2b7962b0b54f3c0e3a4677e99cc02e41e66b0861d02d072b94ce3f8a04fd20d2ec220cea3737922808f00080186421e60b7d1076e5ca40099d54da33033021349e31bb65e12aa259b37bc975582aa6441ab2fabdc9cee0aab0c11c7e3489b93bab26e13bf399ab8a37949baba3c2f8a94fd97a9a551c96d582b5c1ba97b4547701656ee02567dd6a8362c1043c5874760c7d1133292f05c9d3689beccb903d4bd65f09e3e3255d0229daf9050ebaa107e51371fc9248393239575466a9c45b4a239e1b29b07d9701cf1bb488a95a004a98fcb1f6d548cc8554a3eb25a5fc90892618e5d33b04938567e748ab9ba79b0d39d611864b2140666c1791e79c5c0943a03038f7306551db3b271b08dec32443ae14674e16d6c42956ef36499348e7424bbc4883c37675a4f8bb28cd68f30b532ba80104e7214b9a4886045a152d161821a006ae03ae3742e36f63d997c858b850119e1004f4022a04a9533749d993641763a83dce5256f3826ae9b0584c72d69c77d6784444737a0192789e0d63a2f2808ce88b07c33383e588f68b13b892ac6998c9f2db14ba3e10eee4b9717761efc298e026974231a143b89009a724a7121292bb9292662b87502beadb9cbea3cc89de1997b376575f466b6693e18eb70630ba1823cae5f03698ae662190207156ca8d1a4a3cb926d20c92b524180c0804f057491c292024641bf9b21b52214bf2a2b42d16596e22935317bc712e64f64c143b257ca6f663223a1a2b6537b55746a2a739b2adbbfa004354a1555cc8b8215aa06413b27b7fa8c860386c13876b8d55b743860a13c0005dc4ac5e003cd3431c7a29edcc73c50b991e56a12423ac1f2842ed2999b7b31b6e01aaa83c01af658bae959b2cb256f1e7bba29d765e8083182891302569b3712a856e564fdd484b0706b0c68568d5ab7edc742cf74459d64595455a60f267973aa55e43c5be61925a3822eafcca445e36dc4655636e31e6fc9bec338b253f94290008ef7f40dbddb49c15c690f6755a23a1b3c85cfd5207e71a607086a6fc6d74a05080f43276901a19cafdb8de7771d58ea07f0f1056b905127b22223d08e75173199f13ab13c5dcd3b51ac784f84e520484a262b845a897c41cf27324ab6ba545c78c9ccab361051e0bba53498af26240fa0d566d1572684f4b42e253e6d052c848650915063c35641e1121ef8d9cfd17b667b351103c56d195007c9376d0c08aa268396814490eab4c364175a94533267a1933862cc4c33bcf0a13d1fa2b9d6c5082eeca1480672f2526cbe013beff14dc908a386e0b633c8761023cbed760deac6709bc328d865ac82e12307b673d96711dbb27a4d939230d25b53d594169a318be0200fa33550e9418e2a3b30e9719edc09d5fc4306f1abfd021eab14637a8a72c5931d25dc9b56db0e6ab677522b10f25307dbb804a6774ce05b87b0976a4b227bfe6caf20a79e64004fbd27b1eea018b3ab8ffa629f2dc87f19278f95168e94e44660a3370c537795678eb2f056260609769740583b51b291862927a1938737c6a37f40b78f00671cccbcb88ac3427b37915ed58782998f84051647707d48995472baad3f64a7cca54e1c0734db08751c614a34f28b84f2c1b5a6817355ab61957c486b7acffbc092bc8a7b46387f33b53ed372f7168d31a71cd008539928b0cdf91e835aa97f6a2be6d327b87a6ae478701d75a59a25179cb14997bb2552853014724170a1c49b82c2bcebc3279024e1fa44c53c7afdc43f0bd22116490f3b74c90e7296be58b9a91168f2fa0c3d378a3bcac959f357825c9976a8c9ee944f29b45e96d7345d9b478431a20cf1c5d3a3227c717fd204619777636c0cb140db5c50d2a3302334461030bee34e4eb1a6f02b733f9ccda4290fa168bc039568373241542728d00030d1f251e83737cb215adbdc1de75978675a0cd0d75b12748abdda7a9852629c63697d145af2c69854b06e03f37c4b064e4c9a4c03f2ad4d081e70180e9547247921918118086b62b4f7727f46b24e3e79ba3f28209f32b5102035bf935856232f83642268c0292ec6bf8e9462382163d30a20b4bcb7b4439310ec9d0a148193907fc07697342967cf1a16c6b3c71558951fa915400736cf699262b54b723abb2ecc27b74b68ee494287595ef818388adb49e883c67bfa5c226c0eef037a0851a29d34675912c1ea1068310b6dfcd017c809c8fbfc2c3ae78dfef07299960eeefba182662a90fa422c1790f356a2ea909012b15623a9b9e450a282cb530589a68368b3583159d9010ac3e52cc974753c342e58279516339dfb691df94b13a223ad97eb6a09c21dafe6304a3642d6d2067b5238497661fe88ad1227ca3557be2a576b6e17c5a7f997ea07929e76407e376aba74c44cd8504804776f39bbb8327624188a63501e83b404d9438cade0b11dc3ac61856447fb072b91761c228878f01b2eb6b4b21ba664c2c75882431603b25a449ffeb8410b910558581777562aa9b2181fd9c04713ad9326462d3e842121c4997f9aa932417c67851625816de66e0d65637434629f39d157cc40cbafccc4429c35caeda482299013baf565d0f38b8f2886b9641ae6bea5b2bfccd9e6f3000d1a2734414e5b6875828f9ca9b6c3d0ddeaf704111e2b38';

// Resolved-and-cached per instance; `null` = not yet resolved and not overridden.
let __sessionSecret: Uint8Array | null = null;
let __oprfSeed: Uint8Array | null = null;
let __serverKemSk: Uint8Array | null = null;
let __serverKemPk: Uint8Array | null = null;

function __hexNibble(c: i32): i32 {
    if (c >= 48 && c <= 57) return c - 48; // 0-9
    if (c >= 97 && c <= 102) return c - 87; // a-f
    if (c >= 65 && c <= 70) return c - 55; // A-F
    return 0;
}
function __fromHex(s: string): Uint8Array {
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) {
        out[i] = <u8>((__hexNibble(s.charCodeAt(i * 2)) << 4) | __hexNibble(s.charCodeAt(i * 2 + 1)));
    }
    return out;
}

/** The session HMAC secret (UTF-8 of the env value or the DEV fallback). */
function __resolveSessionSecret(): Uint8Array {
    let s = __sessionSecret;
    if (s != null) return s;
    const v = Environment.getSecure(ENV_SESSION_SECRET);
    s = Uint8Array.wrap(String.UTF8.encode(v != null ? v : DEV_SESSION_SECRET));
    __sessionSecret = s;
    return s;
}
/** The OPRF master seed, hashed to 32 bytes (RFC 9497 Ns) so any env value works. */
function __resolveOprfSeed(): Uint8Array {
    let s = __oprfSeed;
    if (s != null) return s;
    const v = Environment.getSecure(ENV_OPRF_SEED);
    s = crypto.sha256Text(v != null ? v : DEV_OPRF_SEED_SRC);
    __oprfSeed = s;
    return s;
}
/** The server static ML-KEM-768 secret (decapsulation) key (2400 bytes). */
function __resolveServerKemSk(): Uint8Array {
    let s = __serverKemSk;
    if (s != null) return s;
    const v = Environment.getSecure(ENV_KEM_SK);
    s = __fromHex(v != null ? v : DEV_KEM_SK_HEX);
    __serverKemSk = s;
    return s;
}
/** The server static ML-KEM-768 PUBLIC key (the `ek` embedded in the dk at bytes
 *  [1152, 2336), FIPS 203 layout), used for the key id bound into the login
 *  transcript. The client pins the same key. */
function __resolveServerKemPk(): Uint8Array {
    let s = __serverKemPk;
    if (s != null) return s;
    s = __resolveServerKemSk().slice(1152, 2336);
    __serverKemPk = s;
    return s;
}

// HMAC-SHA256(key, msg) via the ambient Web Crypto (same path SecureCookies
// uses). The session-key derivation and the mutual-auth confirmation tag are
// both keyed PRFs over the transcript; the client mirrors this with hash-wasm.
function __hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
    const k = crypto.subtle.importKey(
        'raw',
        key,
        new HmacImportParams(ALG_SHA_256),
        false,
        USAGE_SIGN | USAGE_VERIFY,
    );
    return crypto.subtle.sign(new HmacParams(), k, msg);
}

// `utf8(label) || transcriptHash` -- the HMAC message body for the derivations.
function __labelled(label: string, transcriptHash: Uint8Array): Uint8Array {
    const lb = Uint8Array.wrap(String.UTF8.encode(label));
    const buf = new Uint8Array(lb.length + transcriptHash.length);
    buf.set(lb, 0);
    buf.set(transcriptHash, lb.length);
    return buf;
}

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
     * Override the session-signing secret programmatically. OPTIONAL: by default
     * AuthService reads `AUTH_SESSION_SECRET` from the env store (with a DEV
     * fallback), so most apps never call this. An override takes precedence over
     * the env value for the current request; keep it out of any client bundle.
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

        const sealed = SecureCookies.signed(__resolveSessionSecret()).open(
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
        return SecureCookies.signed(__resolveSessionSecret()).seal(cookie);
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
     * verifies. ONE fixed binary layout, no JSON and no version negotiation. The
     * server MUST call this with its OWN stored values, never fields echoed by
     * the client. Both ends produce byte-identical bytes via `DataWriter`:
     *
     *   u8    tag = 1          (format marker, not a compat switch)
     *   str   sub              (username)
     *   str   aud              (this service's audience; server-config constant)
     *   bytes cid              (challenge id)
     *   bytes nonce            (32 random bytes)
     *   u64   iat
     *   u64   exp
     *   bytes ct               (ML-KEM ciphertext; binds the key encapsulation)
     *   u32   memKiB           (Argon2id params, bound so a MITM cannot slip a
     *   u32   iterations        downgrade past the signature)
     *   u32   parallelism
     *   bytes serverKemKeyId   (SHA-256 of the server KEM public key; binds the
     *                           server identity the client encapsulated to)
     */
    export function buildLoginMessage(
        sub: string,
        aud: string,
        cid: Uint8Array,
        nonce: Uint8Array,
        iat: u64,
        exp: u64,
        ciphertext: Uint8Array,
        memKiB: u32,
        iterations: u32,
        parallelism: u32,
        serverKemKeyId: Uint8Array,
    ): Uint8Array {
        const w = new DataWriter();
        w.writeU8(1);
        w.writeString(sub);
        w.writeString(aud);
        w.writeBytes(cid);
        w.writeBytes(nonce);
        w.writeU64(iat);
        w.writeU64(exp);
        w.writeBytes(ciphertext);
        w.writeU32(memKiB);
        w.writeU32(iterations);
        w.writeU32(parallelism);
        w.writeBytes(serverKemKeyId);
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

    /** ML-KEM-768 (FIPS 203) sizes. */
    export const KEM_CIPHERTEXT_LEN: i32 = 1088;
    export const KEM_SECRET_KEY_LEN: i32 = 2400;
    export const KEM_PUBLIC_KEY_LEN: i32 = 1184;
    export const SHARED_SECRET_LEN: i32 = 32;
    /** Serialized ristretto255 OPRF element (blinded / evaluated). */
    export const OPRF_ELEMENT_LEN: i32 = 32;
    /** RFC 9497 DeriveKeyPair seed length (ristretto255 `Ns`). */
    export const OPRF_SEED_LEN: i32 = 32;

    /**
     * Override the OPRF master seed (32 bytes) programmatically. OPTIONAL: by
     * default AuthService reads `AUTH_OPRF_SEED` from the env store (hashed to 32
     * bytes, with a DEV fallback). Per-user OPRF keys derive from this + the
     * username; keep it out of any client bundle.
     */
    export function setOprfSeed(seed: Uint8Array): void {
        __oprfSeed = seed;
    }

    /**
     * Override the server static ML-KEM-768 secret (decapsulation) key (2400
     * bytes) programmatically. OPTIONAL: by default AuthService reads `AUTH_KEM_SK`
     * (hex) from the env store, with a DEV fallback whose public half is pinned in
     * the client. Never put this in a client bundle.
     */
    export function setServerKemSecretKey(secretKey: Uint8Array): void {
        __serverKemSk = secretKey;
    }

    /**
     * Override the server static ML-KEM-768 PUBLIC key (1184 bytes), used to
     * compute {@link serverKemKeyId}. OPTIONAL: by default it is derived from the
     * secret key (the `ek` embedded at bytes [1152, 2336) of the dk), so setting
     * the secret key is enough. Must be the key the client pins.
     */
    export function setServerKemPublicKey(publicKey: Uint8Array): void {
        __serverKemPk = publicKey;
    }

    /**
     * OPRF server step: blind-evaluate the client's `blinded` element under the
     * per-user key derived from the master seed + `username`. Returns the 32-byte
     * evaluated element, or an empty array on any failure. The client unblinds +
     * finalizes locally and feeds the result into Argon2id (the keyed salt).
     */
    export function oprfEvaluate(username: string, blinded: Uint8Array): Uint8Array {
        if (blinded.length != OPRF_ELEMENT_LEN) return new Uint8Array(0);
        const info = Uint8Array.wrap(String.UTF8.encode(username));
        const out = new Uint8Array(OPRF_ELEMENT_LEN);
        const seed = __resolveOprfSeed();
        const rc = __toilVoprfEvaluate(
            seed.dataStart,
            seed.length,
            info.dataStart,
            info.length,
            blinded.dataStart,
            blinded.length,
            out.dataStart,
        );
        return rc == 0 ? out : new Uint8Array(0);
    }

    /**
     * Decapsulate the client's ML-KEM ciphertext with the server static secret
     * key, returning the 32-byte shared secret (empty on failure / unset key).
     * Only the genuine server can produce this, so it underpins mutual auth.
     */
    export function mlkemDecapsulate(ciphertext: Uint8Array): Uint8Array {
        const sk = __resolveServerKemSk();
        if (sk.length != KEM_SECRET_KEY_LEN || ciphertext.length != KEM_CIPHERTEXT_LEN) {
            return new Uint8Array(0);
        }
        const out = new Uint8Array(SHARED_SECRET_LEN);
        const rc = __toilMlkemDecapsulate(
            ciphertext.dataStart,
            ciphertext.length,
            sk.dataStart,
            sk.length,
            out.dataStart,
        );
        return rc == 0 ? out : new Uint8Array(0);
    }

    /** SHA-256 over `data` (ambient Web Crypto), for transcript/confirm hashing. */
    export function sha256(data: Uint8Array): Uint8Array {
        return crypto.subtle.digest('SHA-256', data);
    }

    /** `SHA-256(serverKemPublicKey)` -- the key identity bound into the login
     *  message, so the signature commits to which server key the client
     *  encapsulated to. The client computes the same hash over its pinned key. */
    export function serverKemKeyId(): Uint8Array {
        return sha256(__resolveServerKemPk());
    }

    /** Domain separators for the session-key derivation and confirmation tag. */
    export const SESSION_KEY_LABEL: string = 'toil-session-key-v1';
    export const SERVER_CONFIRM_LABEL: string = 'toil-server-confirm-v1';

    /**
     * Derive the authenticated session key `K` from the ML-KEM shared secret,
     * bound to the transcript: `K = HMAC-SHA256(sharedSecret, SESSION_KEY_LABEL ||
     * transcriptHash)`. The shared secret is already a uniform 32-byte key, so it
     * keys the HMAC directly (an HKDF-Expand step). Both ends derive the same `K`
     * iff the KEM exchange and transcript match.
     *
     * NOTE: `K` is the handle for future channel binding. Binding the *session
     * cookie* to the transport (so a stolen cookie is useless on another channel)
     * needs the TLS exporter, which the wasm guest cannot see -- that is an
     * edge/transport follow-up, not doable purely here.
     */
    export function deriveSessionKey(sharedSecret: Uint8Array, transcriptHash: Uint8Array): Uint8Array {
        return __hmacSha256(sharedSecret, __labelled(SESSION_KEY_LABEL, transcriptHash));
    }

    /**
     * The server's mutual-auth confirmation tag: `HMAC-SHA256(K, SERVER_CONFIRM_LABEL
     * || transcriptHash)`, where `K` is {@link deriveSessionKey}. Only a server
     * that decapsulated correctly (i.e. holds the KEM secret key) derives the same
     * `K`, so the client verifying this tag proves the server's identity.
     */
    export function serverConfirmTag(sessionKey: Uint8Array, transcriptHash: Uint8Array): Uint8Array {
        return __hmacSha256(sessionKey, __labelled(SERVER_CONFIRM_LABEL, transcriptHash));
    }

    /** Registration proof-of-possession context (binds a signature to "register"
     *  so it can never validate as a login). Byte-identical to the client. */
    export const REGISTER_CONTEXT: string = 'qauth:register:v1';

    /**
     * The registration PoP message: `u8(1) str(username) bytes(publicKey)`,
     * signed by the client under {@link REGISTER_CONTEXT}. Verifying it proves
     * the registrant holds the secret key for the public key it is registering.
     */
    export function buildRegisterMessage(username: string, publicKey: Uint8Array): Uint8Array {
        const w = new DataWriter();
        w.writeU8(1);
        w.writeString(username);
        w.writeBytes(publicKey);
        return w.toBytes();
    }

    /** Verify a registration proof-of-possession over `message` against the
     *  submitted `publicKey`, under {@link REGISTER_CONTEXT}. */
    export function verifyRegister(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): bool {
        if (publicKey.length != PUBLIC_KEY_LEN || signature.length != SIGNATURE_LEN) {
            return false;
        }
        const ctx = Uint8Array.wrap(String.UTF8.encode(REGISTER_CONTEXT));
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

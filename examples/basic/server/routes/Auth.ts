import { Response, RouteContext } from 'toiljs/server/runtime';
import { DataReader, DataWriter } from 'data';

import { encodeSessionUser } from './Session';

/**
 * Toil PQ-Auth: post-quantum password login, end-to-end and runnable under `toiljs dev`.
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
 * STORAGE: backed by the DEV-ONLY `kv.*` host imports (see
 * `src/devserver/kv.ts`) so the register -> login chain spans requests under
 * `toiljs dev`. REMOVE LATER: this is a stand-in; once toildb is implemented,
 * the Accounts/Challenges stores move onto it and this goes away. `kv.*` is not
 * on the production edge.
 *
 * Wire: every body/response is binary (`DataWriter`/`DataReader`), never JSON.
 */

const AUD = 'toil-demo'; // this service's audience id (server config; never client-echoed)

// Demo-light Argon2id params (responsive in a browser tab). A real deployment
// uses >= 256 MiB / >= 3 iterations. The client derives against whatever it is
// handed, so this is the single source of truth.
const DEMO_MEM_KIB: u32 = 32768; // 32 MiB
const DEMO_ITERS: u32 = 2;
const DEMO_PAR: u32 = 1;

const CHALLENGE_TTL_SECS: u64 = 120;
const SESSION_TTL_SECS: u64 = 3600;

// DEV server ML-KEM-768 secret (decapsulation) key, hex. Matches the PINNED
// public key in `src/client/auth.ts`. DEV ONLY: a real deployment loads this
// from the secure env store and rotates it; never commit a real one.
const SERVER_KEM_SK_HEX: string = '3156a8eb11c62bdb4af9fc57bef470f880ae340373bcc61662748a9742a639b9ad6bc55a77a82e0caa99ede237b4783ce70ab08ecc5802a9478c4ca3de67acd7a2147db43fdba408e9765443f37e9e90cc09f836d53879b890126bd6c33d55a6d97636a28ba10e18ac919aa9d37c2e4d07b6c930a5cb3238c8338fbb1abe7dac124c93462ebc5ae81cb132947993a74f9602610eab68b7fc9407b58e958aca054443246240c484c650962408168632c303cfc738d3b918ee04a37c2436b6f7300b8c6e7bd528bc5c229673c3a1bc4ae4265772f654ed8377b285626c67a4ef715a5a04a56804c3fae93ca5e3219cd68649622ee0d77bcb664a68e377260a3a38c2739b81c3c9ec510b66acde5041f3b52922a17019dc9afaec71c3e3c3102686ceb019da138b22463ad7f452640526d1d8b21c9111ca844149d1391c937b84287f1a228342c06ccb87c31cb14227e175007c5c4497c11e8647377234a84ab2640aa8ee7acb54954f99155cf7d768446b104ac149f59ca1d0029401570db9341c93db0041d52fbbd62726a75f9ab177e4ea5176e675d28a1f9852c28b38074c91cec8064b6ba116db8b59c0434fbd1b207cd921fbf29b06740b53c7304b17b253652ad469b2cb10bf7ed3bcc5b1b6168c2d30a889f67a01ae79455100ac582ba2f764a4a4b134b9115d7c548032d55d4916ce25c0ce7c42160e446298fb10f747302e781a70b2b7962b0b54f3c0e3a4677e99cc02e41e66b0861d02d072b94ce3f8a04fd20d2ec220cea3737922808f00080186421e60b7d1076e5ca40099d54da33033021349e31bb65e12aa259b37bc975582aa6441ab2fabdc9cee0aab0c11c7e3489b93bab26e13bf399ab8a37949baba3c2f8a94fd97a9a551c96d582b5c1ba97b4547701656ee02567dd6a8362c1043c5874760c7d1133292f05c9d3689beccb903d4bd65f09e3e3255d0229daf9050ebaa107e51371fc9248393239575466a9c45b4a239e1b29b07d9701cf1bb488a95a004a98fcb1f6d548cc8554a3eb25a5fc90892618e5d33b04938567e748ab9ba79b0d39d611864b2140666c1791e79c5c0943a03038f7306551db3b271b08dec32443ae14674e16d6c42956ef36499348e7424bbc4883c37675a4f8bb28cd68f30b532ba80104e7214b9a4886045a152d161821a006ae03ae3742e36f63d997c858b850119e1004f4022a04a9533749d993641763a83dce5256f3826ae9b0584c72d69c77d6784444737a0192789e0d63a2f2808ce88b07c33383e588f68b13b892ac6998c9f2db14ba3e10eee4b9717761efc298e026974231a143b89009a724a7121292bb9292662b87502beadb9cbea3cc89de1997b376575f466b6693e18eb70630ba1823cae5f03698ae662190207156ca8d1a4a3cb926d20c92b524180c0804f057491c292024641bf9b21b52214bf2a2b42d16596e22935317bc712e64f64c143b257ca6f663223a1a2b6537b55746a2a739b2adbbfa004354a1555cc8b8215aa06413b27b7fa8c860386c13876b8d55b743860a13c0005dc4ac5e003cd3431c7a29edcc73c50b991e56a12423ac1f2842ed2999b7b31b6e01aaa83c01af658bae959b2cb256f1e7bba29d765e8083182891302569b3712a856e564fdd484b0706b0c68568d5ab7edc742cf74459d64595455a60f267973aa55e43c5be61925a3822eafcca445e36dc4655636e31e6fc9bec338b253f94290008ef7f40dbddb49c15c690f6755a23a1b3c85cfd5207e71a607086a6fc6d74a05080f43276901a19cafdb8de7771d58ea07f0f1056b905127b22223d08e75173199f13ab13c5dcd3b51ac784f84e520484a262b845a897c41cf27324ab6ba545c78c9ccab361051e0bba53498af26240fa0d566d1572684f4b42e253e6d052c848650915063c35641e1121ef8d9cfd17b667b351103c56d195007c9376d0c08aa268396814490eab4c364175a94533267a1933862cc4c33bcf0a13d1fa2b9d6c5082eeca1480672f2526cbe013beff14dc908a386e0b633c8761023cbed760deac6709bc328d865ac82e12307b673d96711dbb27a4d939230d25b53d594169a318be0200fa33550e9418e2a3b30e9719edc09d5fc4306f1abfd021eab14637a8a72c5931d25dc9b56db0e6ab677522b10f25307dbb804a6774ce05b87b0976a4b227bfe6caf20a79e64004fbd27b1eea018b3ab8ffa629f2dc87f19278f95168e94e44660a3370c537795678eb2f056260609769740583b51b291862927a1938737c6a37f40b78f00671cccbcb88ac3427b37915ed58782998f84051647707d48995472baad3f64a7cca54e1c0734db08751c614a34f28b84f2c1b5a6817355ab61957c486b7acffbc092bc8a7b46387f33b53ed372f7168d31a71cd008539928b0cdf91e835aa97f6a2be6d327b87a6ae478701d75a59a25179cb14997bb2552853014724170a1c49b82c2bcebc3279024e1fa44c53c7afdc43f0bd22116490f3b74c90e7296be58b9a91168f2fa0c3d378a3bcac959f357825c9976a8c9ee944f29b45e96d7345d9b478431a20cf1c5d3a3227c717fd204619777636c0cb140db5c50d2a3302334461030bee34e4eb1a6f02b733f9ccda4290fa168bc039568373241542728d00030d1f251e83737cb215adbdc1de75978675a0cd0d75b12748abdda7a9852629c63697d145af2c69854b06e03f37c4b064e4c9a4c03f2ad4d081e70180e9547247921918118086b62b4f7727f46b24e3e79ba3f28209f32b5102035bf935856232f83642268c0292ec6bf8e9462382163d30a20b4bcb7b4439310ec9d0a148193907fc07697342967cf1a16c6b3c71558951fa915400736cf699262b54b723abb2ecc27b74b68ee494287595ef818388adb49e883c67bfa5c226c0eef037a0851a29d34675912c1ea1068310b6dfcd017c809c8fbfc2c3ae78dfef07299960eeefba182662a90fa422c1790f356a2ea909012b15623a9b9e450a282cb530589a68368b3583159d9010ac3e52cc974753c342e58279516339dfb691df94b13a223ad97eb6a09c21dafe6304a3642d6d2067b5238497661fe88ad1227ca3557be2a576b6e17c5a7f997ea07929e76407e376aba74c44cd8504804776f39bbb8327624188a63501e83b404d9438cade0b11dc3ac61856447fb072b91761c228878f01b2eb6b4b21ba664c2c75882431603b25a449ffeb8410b910558581777562aa9b2181fd9c04713ad9326462d3e842121c4997f9aa932417c67851625816de66e0d65637434629f39d157cc40cbafccc4429c35caeda482299013baf565d0f38b8f2886b9641ae6bea5b2bfccd9e6f3000d1a2734414e5b6875828f9ca9b6c3d0ddeaf704111e2b38';


function utf8(s: string): Uint8Array {
    return Uint8Array.wrap(String.UTF8.encode(s));
}

function fromHex(s: string): Uint8Array {
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) {
        out[i] = <u8>(hexNibble(s.charCodeAt(i * 2)) * 16 + hexNibble(s.charCodeAt(i * 2 + 1)));
    }
    return out;
}
function hexNibble(c: i32): i32 {
    if (c >= 48 && c <= 57) return c - 48; // 0-9
    if (c >= 97 && c <= 102) return c - 87; // a-f
    if (c >= 65 && c <= 70) return c - 55; // A-F
    return 0;
}
function toHex(b: Uint8Array): string {
    let s = '';
    for (let i = 0; i < b.length; i++) {
        const v = b[i];
        s += (v < 16 ? '0' : '') + (<u32>v).toString(16);
    }
    return s;
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
    return crypto.sha256Text('toil-demo-salt-v1:' + username).slice(0, 16);
}


let __configured = false;
function ensureConfigured(): void {
    if (__configured) return;
    // OPRF master seed: 32 bytes from a fixed label (a real deployment uses a
    // secret from the env store). Per-user OPRF keys derive from this + username.
    AuthService.setOprfSeed(crypto.sha256Text('toil-demo-oprf-seed-v1'));
    // Server static ML-KEM secret key (matches the client's pinned public key).
    const sk = fromHex(SERVER_KEM_SK_HEX);
    AuthService.setServerKemSecretKey(sk);
    // The ML-KEM-768 public key (ek) is embedded in the decapsulation key at
    // bytes [1152, 2336) (FIPS 203 dk layout); use it for the key id the login
    // message binds. Identical to the public key the client pins.
    AuthService.setServerKemPublicKey(sk.slice(1152, 2336));
    __configured = true;
}


// @ts-ignore: decorator
@external('env', 'kv.put')
declare function __kvPut(keyPtr: usize, keyLen: i32, valPtr: usize, valLen: i32): void;
// @ts-ignore: decorator
@external('env', 'kv.get')
declare function __kvGet(keyPtr: usize, keyLen: i32, outPtr: usize, outCap: i32): i32;
// @ts-ignore: decorator
@external('env', 'kv.getdel')
declare function __kvGetDel(keyPtr: usize, keyLen: i32, outPtr: usize, outCap: i32): i32;

const KV_CAP: i32 = 8192; // bounds account (~1.5 KiB) + challenge (~100 B) records

function kvPut(key: Uint8Array, val: Uint8Array): void {
    __kvPut(key.dataStart, key.length, val.dataStart, val.length);
}
function kvGet(key: Uint8Array): Uint8Array | null {
    const out = new Uint8Array(KV_CAP);
    const n = __kvGet(key.dataStart, key.length, out.dataStart, KV_CAP);
    if (n < 0) return null;
    return out.slice(0, n);
}
/** Atomic fetch-and-delete: consumes a login challenge exactly once. */
function kvGetDel(key: Uint8Array): Uint8Array | null {
    const out = new Uint8Array(KV_CAP);
    const n = __kvGetDel(key.dataStart, key.length, out.dataStart, KV_CAP);
    if (n < 0) return null;
    return out.slice(0, n);
}

function acctKey(username: string): Uint8Array {
    return utf8('acct:' + username);
}
function chalKey(cid: Uint8Array): Uint8Array {
    return utf8('chal:' + toHex(cid));
}


class Account {
    username: string = '';
    salt: Uint8Array = new Uint8Array(0);
    publicKey: Uint8Array = new Uint8Array(0);
    memKiB: u32 = 0;
    iterations: u32 = 0;
    parallelism: u32 = 0;
}

function putAccount(a: Account): void {
    const w = new DataWriter();
    w.writeString(a.username);
    w.writeBytes(a.salt);
    w.writeBytes(a.publicKey);
    w.writeU32(a.memKiB);
    w.writeU32(a.iterations);
    w.writeU32(a.parallelism);
    kvPut(acctKey(a.username), w.toBytes());
}
function getAccount(username: string): Account | null {
    const raw = kvGet(acctKey(username));
    if (raw == null) return null;
    const r = new DataReader(raw);
    const a = new Account();
    a.username = r.readString();
    a.salt = r.readBytes();
    a.publicKey = r.readBytes();
    a.memKiB = r.readU32();
    a.iterations = r.readU32();
    a.parallelism = r.readU32();
    return r.ok ? a : null;
}

class Challenge {
    cid: Uint8Array = new Uint8Array(0);
    username: string = '';
    nonce: Uint8Array = new Uint8Array(0);
    iat: u64 = 0;
    exp: u64 = 0;
}

function putChallenge(c: Challenge): void {
    const w = new DataWriter();
    w.writeBytes(c.cid);
    w.writeString(c.username);
    w.writeBytes(c.nonce);
    w.writeU64(c.iat);
    w.writeU64(c.exp);
    kvPut(chalKey(c.cid), w.toBytes());
}
function consumeChallenge(cid: Uint8Array): Challenge | null {
    const raw = kvGetDel(chalKey(cid));
    if (raw == null) return null;
    const r = new DataReader(raw);
    const c = new Challenge();
    c.cid = r.readBytes();
    c.username = r.readString();
    c.nonce = r.readBytes();
    c.iat = r.readU64();
    c.exp = r.readU64();
    return r.ok ? c : null;
}

@rest('auth')
class Auth {
    /** POST /auth/register/start  body: str(username) bytes(blinded)
     *  resp: u8(status=0) u32(mem) u32(iters) u32(par) bytes(salt) bytes(evaluated)
     *  No taken-oracle: always succeeds; register/finish rejects a duplicate. */
    @post('/register/start')
    public registerStart(ctx: RouteContext): Response {
        ensureConfigured();
        const r = new DataReader(ctx.request.body);
        const username = r.readString();
        const blinded = r.readBytes();
        if (!r.ok) return fail();
        const evaluated = AuthService.oprfEvaluate(username, blinded);
        if (evaluated.length != AuthService.OPRF_ELEMENT_LEN) return fail();

        const w = new DataWriter();
        w.writeU8(0);
        w.writeU32(DEMO_MEM_KIB);
        w.writeU32(DEMO_ITERS);
        w.writeU32(DEMO_PAR);
        w.writeBytes(deriveSalt(username));
        w.writeBytes(evaluated);
        return Response.bytes(w.toBytes());
    }

    /** POST /auth/register/finish  body: str(username) bytes(pk) bytes(regProof)
     *  resp: u8(status) -- 0 = ok, 1 = username already registered. Verifies
     *  proof-of-possession before storing the key. */
    @post('/register/finish')
    public registerFinish(ctx: RouteContext): Response {
        ensureConfigured();
        const r = new DataReader(ctx.request.body);
        const username = r.readString();
        const pk = r.readBytes();
        const proof = r.readBytes();
        if (!r.ok) return fail();
        if (pk.length != AuthService.PUBLIC_KEY_LEN) return fail();
        // Already registered: a distinguishable status (not the generic 401) so the
        // client can say "username taken, log in instead" rather than a blank error.
        if (getAccount(username) != null) {
            return Response.bytes(new DataWriter().writeU8(1).toBytes());
        }

        // Proof-of-possession: the client signed buildRegisterMessage with the
        // matching secret key, so we confirm it actually holds it.
        const regMsg = AuthService.buildRegisterMessage(username, pk);
        if (!AuthService.verifyRegister(pk, regMsg, proof)) return fail();

        const a = new Account();
        a.username = username;
        a.salt = deriveSalt(username);
        a.publicKey = pk;
        a.memKiB = DEMO_MEM_KIB;
        a.iterations = DEMO_ITERS;
        a.parallelism = DEMO_PAR;
        putAccount(a);
        return Response.bytes(new DataWriter().writeU8(0).toBytes());
    }

    /** POST /auth/login/start  body: str(username) bytes(blinded)
     *  resp: bytes(cid) str(aud) u32(mem) u32(iters) u32(par) bytes(salt)
     *        bytes(nonce) u64(iat) u64(exp) bytes(evaluated)
     *  Anti-enumeration: ALWAYS OPRF-evaluates (real or decoy key from the same
     *  seed+username), returns a deterministic per-user salt + constant params,
     *  and a fresh challenge -- a known and an unknown user are indistinguishable. */
    @post('/login/start')
    public loginStart(ctx: RouteContext): Response {
        ensureConfigured();
        const r = new DataReader(ctx.request.body);
        const username = r.readString();
        const blinded = r.readBytes();
        if (!r.ok) return fail();
        const evaluated = AuthService.oprfEvaluate(username, blinded);
        if (evaluated.length != AuthService.OPRF_ELEMENT_LEN) return fail();

        const acct = getAccount(username);
        const cid = randomBytes(16);
        const nonce = randomBytes(32);
        const iat = nowSecs();
        const exp = iat + CHALLENGE_TTL_SECS;

        // Persist only for a real account; the response is identical either way,
        // and login/finish for an unknown user fails generically at consume.
        if (acct != null) {
            const c = new Challenge();
            c.cid = cid;
            c.username = username;
            c.nonce = nonce;
            c.iat = iat;
            c.exp = exp;
            putChallenge(c);
        }

        const w = new DataWriter();
        w.writeBytes(cid);
        w.writeString(AUD);
        w.writeU32(DEMO_MEM_KIB);
        w.writeU32(DEMO_ITERS);
        w.writeU32(DEMO_PAR);
        w.writeBytes(deriveSalt(username));
        w.writeBytes(nonce);
        w.writeU64(iat);
        w.writeU64(exp);
        w.writeBytes(evaluated);
        return Response.bytes(w.toBytes());
    }

    /** POST /auth/login/finish  body: bytes(cid) bytes(ct) bytes(sig)
     *  resp: u8(status) [+ bytes(sessionToken) bytes(serverConfirm)] + Set-Cookie */
    @post('/login/finish')
    public loginFinish(ctx: RouteContext): Response {
        ensureConfigured();
        const r = new DataReader(ctx.request.body);
        const cid = r.readBytes();
        const ct = r.readBytes();
        const sig = r.readBytes();
        if (!r.ok) return fail();

        // 1. CONSUME FIRST: atomic fetch-and-delete. Unknown/used/expired => fail.
        const ch = consumeChallenge(cid);
        if (ch == null) return fail();
        if (nowSecs() >= ch.exp) return fail();

        // 2. Rebuild the message from OUR stored values + the client's ct (and
        //    the bound params + server key id), load the account key, verify.
        const acct = getAccount(ch.username);
        if (acct == null) return fail();
        const message = AuthService.buildLoginMessage(
            ch.username, AUD, cid, ch.nonce, ch.iat, ch.exp,
            ct, DEMO_MEM_KIB, DEMO_ITERS, DEMO_PAR, AuthService.serverKemKeyId(),
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

        // 4. Success: mint the session and return {0, sessionToken, confirm}.
        const userData = encodeSessionUser(ch.username);
        const w = new DataWriter();
        w.writeU8(0);
        w.writeBytes(userData); // opaque session token (the readable user payload)
        w.writeBytes(confirm);
        const resp = Response.bytes(w.toBytes());
        resp.setCookie(AuthService.mintSession(userData, SESSION_TTL_SECS));
        resp.setCookie(AuthService.userCookie(userData, SESSION_TTL_SECS));
        return resp;
    }
}

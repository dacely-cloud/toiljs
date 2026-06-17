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

function utf8(s: string): Uint8Array {
    return Uint8Array.wrap(String.UTF8.encode(s));
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

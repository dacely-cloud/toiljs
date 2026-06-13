import { Method, Response, RouteContext } from 'toiljs/server/runtime';
import { DataReader, DataWriter } from 'data';

/**
 * Post-quantum auth, illustrative. Shows how a tenant wires the no-import
 * `AuthService` global into a challenge-response login. ML-DSA-44 keypairs are
 * derived client-side from the password (Argon2id); the server only ever stores
 * and verifies PUBLIC material.
 *
 * STORAGE IS THE APP'S, AND THIS EXAMPLE DOES NOT PROVIDE IT. A tenant's wasm
 * memory is wiped after every request, so the account record and the login
 * challenges CANNOT live in this module across the two round trips. A real
 * deployment must back `Accounts` and `Challenges` with an external store, and
 * the challenge "consume" MUST be a single atomic fetch-and-delete shared by
 * all instances (Redis `GETDEL`, or SQL `DELETE ... RETURNING`) -- never a
 * read-then-delete, or a sniffed signature replays across a race. The stubs
 * below throw to make that explicit; swap them for your store + a host KV/db
 * binding. The crypto and encoding (`AuthService`) are production-ready; the
 * orchestration here is a template.
 *
 * Wire: every body/response is binary (`DataWriter`/`DataReader`), never JSON.
 * The client half lives in `toiljs/client` (`Auth.register` / `Auth.login`).
 */

const AUD = 'toil-demo'; // this service's audience id (server config; never client-echoed)
const MIN_MEM_KIB = 256 * 1024; // 256 MiB floor (KDF-params-as-credential)
const MIN_ITERATIONS = 3;

class AccountRecord {
    username: string = '';
    salt: Uint8Array = new Uint8Array(0);
    publicKey: Uint8Array = new Uint8Array(0);
    memKiB: u32 = 0;
    iterations: u32 = 0;
    parallelism: u32 = 0;
}

class ChallengeRecord {
    cid: Uint8Array = new Uint8Array(0);
    username: string = '';
    nonce: Uint8Array = new Uint8Array(0);
    iat: u64 = 0;
    exp: u64 = 0;
}

// --- the storage the app MUST provide (external; these throw on purpose) -----
namespace Accounts {
    export function get(_username: string): AccountRecord | null {
        throw new Error('wire Accounts to your store');
    }
    export function exists(_username: string): bool {
        throw new Error('wire Accounts to your store');
    }
    export function put(_a: AccountRecord): void {
        throw new Error('wire Accounts to your store');
    }
}
namespace Challenges {
    export function put(_c: ChallengeRecord): void {
        throw new Error('wire Challenges to your store');
    }
    /** Atomic fetch-and-delete by cid (Redis GETDEL / SQL DELETE RETURNING). */
    export function consume(_cid: Uint8Array): ChallengeRecord | null {
        throw new Error('wire Challenges to an ATOMIC store');
    }
}

function randomBytes(n: i32): Uint8Array {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
}

function fail(): Response {
    // One generic error on every failure path (anti-enumeration, anti-oracle).
    return Response.text('auth: request failed\n', 401);
}

@rest('auth')
class Auth {
    /** POST /auth/register/start  body: str(username)
     *  resp: u8(status=0) + u32(mem) u32(iters) u32(par) bytes(salt) */
    @post('/register/start')
    public registerStart(ctx: RouteContext): Response {
        const username = new DataReader(ctx.request.body).readString();
        if (Accounts.exists(username)) {
            return new Response(200, new DataWriter().writeU8(1).toBytes().slice(0)); // taken
        }
        const salt = randomBytes(16);
        const w = new DataWriter();
        w.writeU8(0);
        w.writeU32(<u32>MIN_MEM_KIB);
        w.writeU32(<u32>MIN_ITERATIONS);
        w.writeU32(1);
        w.writeBytes(salt);
        // NOTE: the salt must be persisted with the pending registration so
        // registerFinish stores the same one; omitted here (no store).
        return Response.bytes(w.toBytes());
    }

    /** POST /auth/register/finish  body: str(username) bytes(pk)  resp: u8(status) */
    @post('/register/finish')
    public registerFinish(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const username = r.readString();
        const pk = r.readBytes();
        if (Accounts.exists(username) || pk.length != 1312) return fail(); // ML-DSA-44 pk
        const a = new AccountRecord();
        a.username = username;
        a.publicKey = pk;
        a.memKiB = <u32>MIN_MEM_KIB;
        a.iterations = <u32>MIN_ITERATIONS;
        a.parallelism = 1;
        // a.salt = <the salt issued in registerStart>;
        Accounts.put(a);
        return Response.bytes(new DataWriter().writeU8(0).toBytes());
    }

    /** POST /auth/login/start  body: str(username)
     *  resp: bytes(cid) str(aud) u32(mem) u32(iters) u32(par) bytes(salt) bytes(nonce) u64(iat) u64(exp) */
    @post('/login/start')
    public loginStart(ctx: RouteContext): Response {
        const username = new DataReader(ctx.request.body).readString();
        const acct = Accounts.get(username);

        const cid = randomBytes(16);
        const nonce = randomBytes(32);
        const iat = <u64>(Date.now() / 1000);
        const exp = iat + 120;

        // Anti-enumeration: unknown user still gets a fully-formed challenge with
        // a throwaway salt; the eventual verify just fails.
        const salt = acct != null ? acct.salt : randomBytes(16);
        const mem = acct != null ? acct.memKiB : <u32>MIN_MEM_KIB;
        const iters = acct != null ? acct.iterations : <u32>MIN_ITERATIONS;
        const par = acct != null ? acct.parallelism : 1;

        if (acct != null) {
            const c = new ChallengeRecord();
            c.cid = cid;
            c.username = username;
            c.nonce = nonce;
            c.iat = iat;
            c.exp = exp;
            Challenges.put(c);
        }

        const w = new DataWriter();
        w.writeBytes(cid);
        w.writeString(AUD);
        w.writeU32(mem);
        w.writeU32(iters);
        w.writeU32(par);
        w.writeBytes(salt);
        w.writeBytes(nonce);
        w.writeU64(iat);
        w.writeU64(exp);
        return Response.bytes(w.toBytes());
    }

    /** POST /auth/login/finish  body: bytes(cid) bytes(sig)  resp: u8(status) [+ bytes(session)] */
    @post('/login/finish')
    public loginFinish(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const cid = r.readBytes();
        const sig = r.readBytes();

        // 1. CONSUME FIRST: atomic fetch-and-delete. Unknown/used/expired => fail.
        const ch = Challenges.consume(cid);
        if (ch == null) return fail();
        const now = <u64>(Date.now() / 1000);
        if (now >= ch.exp) return fail();

        // 2. Rebuild the message from OUR stored values (never client-echoed),
        //    load the account's public key, verify under the login context.
        const acct = Accounts.get(ch.username);
        if (acct == null) return fail();
        const message = AuthService.buildLoginMessage(ch.username, AUD, cid, ch.nonce, ch.iat, ch.exp);
        if (!AuthService.verifyLogin(acct.publicKey, message, sig)) return fail();

        // 3. Success: mint a session (cookie / token). App-specific.
        return Response.bytes(new DataWriter().writeU8(0).toBytes());
    }
}

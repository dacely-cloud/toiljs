import { Response, RouteContext, SecureCookies, base64UrlEncode, base64UrlDecode } from 'toiljs/server/runtime';
import { DataReader, DataWriter } from 'data';

import { encodeSessionUser } from './Session';

/**
 * Post-quantum identity demo (server half), challenge-response.
 *
 *   1. GET  /pq/challenge -> the edge mints a fresh nonce + cid + iat/exp and
 *      returns them PLUS an HMAC-signed `token` over those values. The token is
 *      the server-issued challenge: signed with a server-only key, it proves
 *      "the edge issued exactly this" WITHOUT any cross-request storage (the
 *      guest's memory is wiped every request).
 *   2. POST /pq/verify   -> the client signs the login message built from the
 *      SERVER's nonce/cid/iat/exp (ML-DSA-44, derived from the password) and
 *      returns {sub, token, publicKey, signature}. The edge re-opens the token
 *      (rejecting a forged or expired one), rebuilds the message from the values
 *      INSIDE the token (never client-echoed), and verifies the signature via
 *      `crypto.mldsa_verify` (`AuthService.verifyLogin`).
 *
 * The nonce is server-chosen and tamper-proof, and the challenge is time-bound,
 * so a client cannot pre-sign or substitute its own nonce. What this stateless
 * form does NOT have is single-use: within the TTL a captured {token, signature}
 * could be replayed, because that needs an atomic consume against a store (Redis
 * GETDEL / SQL DELETE RETURNING). The production login in server/routes/Auth.ts
 * does exactly that; see docs/auth.md. Pairs with client/routes/pq.tsx.
 */

const AUD = 'pq-demo'; // this demo's audience id (server config; never client-echoed)
const CHALLENGE_TTL_SECS: u64 = 120;

/** Server-only key for signing challenge tokens (demo constant; a real
 *  deployment uses a per-deployment secret, like the session secret). */
function challengeKey(): Uint8Array {
    return crypto.sha256Text('toil-pq-demo-challenge-key-v1');
}

function randomBytes(n: i32): Uint8Array {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
}

@rest('pq')
class PqDemo {
    /** GET /pq/challenge
     *  resp: str(aud) bytes(cid) bytes(nonce) u64(iat) u64(exp) str(token) */
    @get('/challenge')
    public challenge(_ctx: RouteContext): Response {
        const cid = randomBytes(16);
        const nonce = randomBytes(32);
        const iat = Time.nowSeconds();
        const exp = iat + CHALLENGE_TTL_SECS;

        // Sign (iat, exp, cid, nonce) so /verify can confirm the edge issued
        // this exact challenge with no stored state.
        const blob = new DataWriter()
            .writeU64(iat)
            .writeU64(exp)
            .writeBytes(cid)
            .writeBytes(nonce)
            .toBytes();
        const token = SecureCookies.signed(challengeKey()).sign('pqchal', base64UrlEncode(blob));

        const w = new DataWriter();
        w.writeString(AUD);
        w.writeBytes(cid);
        w.writeBytes(nonce);
        w.writeU64(iat);
        w.writeU64(exp);
        w.writeString(token);
        return Response.bytes(w.toBytes());
    }

    /** POST /pq/verify
     *  body: str(sub) str(token) bytes(publicKey 1312) bytes(signature 2420)
     *  resp: text VALID / INVALID */
    @post('/verify')
    public verify(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const sub = r.readString();
        const token = r.readString();
        const pk = r.readBytes();
        const sig = r.readBytes();
        if (!r.ok) return Response.text('malformed envelope\n', 400);

        // 1. Re-open the challenge token: must be server-issued + untampered.
        const blobB64 = SecureCookies.signed(challengeKey()).unsign('pqchal', token);
        if (blobB64 == null) return Response.text('INVALID: forged or unsigned challenge\n', 401);
        const blob = base64UrlDecode(blobB64);
        if (blob == null) return Response.text('INVALID: malformed challenge\n', 401);
        const br = new DataReader(blob);
        const iat = br.readU64();
        const exp = br.readU64();
        const cid = br.readBytes();
        const nonce = br.readBytes();
        if (!br.ok) return Response.text('INVALID: malformed challenge\n', 401);
        if (Time.nowSeconds() >= exp) return Response.text('INVALID: challenge expired\n', 401);

        // TODO(db): single-use consume is NOT implemented yet (no KV/DB host
        // binding available). The real fix is an ATOMIC consume of `cid` here --
        // Redis GETDEL / SQL DELETE ... RETURNING -- so a given challenge verifies
        // at most once. Until that exists, this token is replayable within its
        // TTL: a captured {token, signature} re-verifies until `exp`. The
        // production login (server/routes/Auth.ts) shows the atomic-consume shape.

        // 2. Rebuild the message from the SERVER's values (inside the token,
        //    never client-echoed) and verify the ML-DSA-44 signature.
        const message = AuthService.buildLoginMessage(sub, AUD, cid, nonce, iat, exp);
        if (!AuthService.verifyLogin(pk, message, sig)) {
            return Response.text('INVALID: signature did not verify\n', 401);
        }

        // 3. FULL AUTH: a valid post-quantum proof logs the user in. Mint the
        //    signed session for the proven `sub` via the @user codec, plus the
        //    readable companion. Every `@auth` route now recognises this user
        //    and `AuthService.getUser()` returns `{ username: sub, ... }`.
        const userData = encodeSessionUser(sub);
        const resp = Response.text(
            'VALID: ML-DSA-44 (FIPS 204) verified; session established (@auth ready)\n',
            200,
        );
        resp.setCookie(AuthService.mintSession(userData, 3600));
        resp.setCookie(AuthService.userCookie(userData, 3600));
        return resp;
    }
}

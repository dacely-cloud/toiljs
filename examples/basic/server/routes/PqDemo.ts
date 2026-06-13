import { Response, RouteContext } from 'toiljs/server/runtime';
import { DataReader } from 'data';

/**
 * Post-quantum identity demo (server half). The client derives an ML-DSA-44
 * keypair from a password (Argon2id -> ML-DSA-44.KeyGen), signs a login
 * challenge it chose, and posts the public key + signature; the edge rebuilds
 * the exact signed message and verifies it through the `crypto.mldsa_verify`
 * host import (`AuthService.verifyLogin`). Only public material crosses the
 * wire -- the server never holds a secret.
 *
 * STATELESS: this proves the crypto path (derive -> sign -> edge verify) in one
 * request. It is NOT the production login -- there is no server-issued challenge,
 * so no anti-replay. The full register/login protocol is in server/routes/Auth.ts
 * (it needs an external account + challenge store). Pairs with
 * client/routes/pq.tsx; see docs/auth.md.
 */
@rest('pq')
class PqDemo {
    /** POST /pq/verify
     *  body: str(sub) str(aud) bytes(cid) bytes(nonce) u64(iat) u64(exp)
     *        bytes(publicKey 1312) bytes(signature 2420)
     *  resp: text VALID / INVALID */
    @post('/verify')
    public verify(ctx: RouteContext): Response {
        const r = new DataReader(ctx.request.body);
        const sub = r.readString();
        const aud = r.readString();
        const cid = r.readBytes();
        const nonce = r.readBytes();
        const iat = r.readU64();
        const exp = r.readU64();
        const pk = r.readBytes();
        const sig = r.readBytes();
        if (!r.ok) return Response.text('malformed envelope\n', 400);

        // Rebuild the canonical login message and verify under the login context.
        const message = AuthService.buildLoginMessage(sub, aud, cid, nonce, iat, exp);
        const ok = AuthService.verifyLogin(pk, message, sig);
        return Response.text(
            ok
                ? 'VALID: the edge verified the ML-DSA-44 signature (FIPS 204) via crypto.mldsa_verify\n'
                : 'INVALID: signature did not verify\n',
            ok ? 200 : 401,
        );
    }
}

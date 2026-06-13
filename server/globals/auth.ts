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

import { Server } from '../runtime/env/Server';
import { base64UrlDecode, base64UrlEncode } from '../runtime/http/base64';
import { Cookie, SameSite } from '../runtime/http/cookie';
import { SecureCookies } from '../runtime/http/securecookies';

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

export namespace AuthService {
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

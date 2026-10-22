// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * `SecureCookies` — tamper-proof and confidential cookie values, built on the
 * ambient `crypto` global and bounded native base64 codecs.
 *
 *  - `SecureCookies.signed(key)` — HMAC-SHA256. The value stays readable but is
 *    bound to the cookie name, so it cannot be tampered with or moved to another
 *    cookie. Sealed form: `base64url(value) "." base64url(mac)`.
 *  - `SecureCookies.encrypted(key)` — AES-256-GCM with a random 96-bit IV and
 *    the cookie name as AAD. The value is confidential and authenticated.
 *    Sealed form: `base64url(iv ‖ ciphertext ‖ tag)`.
 *
 * Keys are caller-supplied raw bytes (HMAC: any length; AES: 16 or 32 bytes).
 * Extra keys can be added for rotation: seal with the first, open with any.
 *
 * Verification and decryption are panic-free against attacker input: given a
 * valid key, a tampered or truncated sealed value yields `null`, never a trap
 * (`decrypt` reads the host return code directly rather than letting
 * `subtle.decrypt` throw on a bad tag, since toilscript runs with exceptions
 * disabled). Sealing with a misconfigured key (e.g. a wrong-length AES key) is a
 * server-side error and is rejected up front by the factory.
 *
 * Ambient global (`@global`) and exported from `toiljs/server/runtime`.
 */
import { Cookie } from './cookie';
import { CookieMap } from './cookies';
export declare class SecureCookies {
    private mode;
    private keys;
    private constructor();
    /** HMAC-SHA256 signer/verifier with `key` (any length). */
    static signed(key: Uint8Array): SecureCookies;
    /** AES-256-GCM (or AES-128-GCM) with `key` (32 or 16 bytes). */
    static encrypted(key: Uint8Array): SecureCookies;
    /** Add a fallback key for rotation: sealing uses the first key, opening tries all. */
    addKey(key: Uint8Array): SecureCookies;
    private importHmac;
    private importAes;
    /** Return the signed (name-bound) sealed value for `name=value`. */
    sign(name: string, value: string): string;
    /** Verify a signed value for `name`, returning the plaintext or `null`. */
    unsign(name: string, sealed: string): string | null;
    /** Return the AES-GCM-encrypted sealed value for `name` / `value`. */
    encrypt(name: string, value: string): string;
    /** Decrypt a sealed value for `name`, returning the plaintext or `null`. */
    decrypt(name: string, sealed: string): string | null;
    /**
     * Seal `cookie`'s value in place (sign or encrypt per this instance's mode)
     * and mark it `Raw` (the sealed value is already cookie-safe base64url).
     * Returns the same cookie for chaining.
     */
    seal(cookie: Cookie): Cookie;
    /** Read and open cookie `name` from a parsed jar, or `null` if missing/invalid. */
    open(jar: CookieMap, name: string): string | null;
}

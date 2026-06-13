/**
 * `SecureCookies` — tamper-proof and confidential cookie values, built on the
 * ambient `crypto` global (no new host functions).
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

import {
    CryptoKey,
    AlgorithmParams,
    AesGcmParams,
    HmacImportParams,
    HmacParams,
    ALG_AES_GCM,
    ALG_SHA_256,
    USAGE_SIGN,
    USAGE_VERIFY,
    USAGE_ENCRYPT,
    USAGE_DECRYPT,
} from 'crypto';
import { DataWriter } from 'data';
import { webcrypto } from 'bindings/webcrypto';

import { Cookie, CookieEncoding } from './cookie';
import { CookieMap } from './cookies';
import { base64UrlEncode, base64UrlDecode } from './base64';

const MODE_SIGNED: i32 = 0;
const MODE_ENCRYPTED: i32 = 1;

const IV_LEN: i32 = 12;
const TAG_LEN: i32 = 16;

/** Import params carrying just the AES-GCM algorithm id (the host stores the raw key). */
class AesKeyParams extends AlgorithmParams {
    serialize(w: DataWriter): void {
        w.writeI32(ALG_AES_GCM);
        w.writeI32(0);
    }
}

function utf8(s: string): Uint8Array {
    return Uint8Array.wrap(String.UTF8.encode(s));
}

function fromUtf8(b: Uint8Array): string {
    return String.UTF8.decodeUnsafe(b.dataStart, b.byteLength);
}

/** AES-GCM keys must be 16 or 32 bytes; fail early with a clear message. */
function assertAesKeyLen(key: Uint8Array): void {
    if (key.length != 16 && key.length != 32) {
        throw new Error('SecureCookies.encrypted requires a 16- or 32-byte key (AES-128/256)');
    }
}

@global
export class SecureCookies {
    private mode: i32;
    private keys: Array<Uint8Array>;

    private constructor(mode: i32, key: Uint8Array) {
        this.mode = mode;
        this.keys = new Array<Uint8Array>();
        this.keys.push(key);
    }

    /** HMAC-SHA256 signer/verifier with `key` (any length). */
    static signed(key: Uint8Array): SecureCookies {
        return new SecureCookies(MODE_SIGNED, key);
    }

    /** AES-256-GCM (or AES-128-GCM) with `key` (32 or 16 bytes). */
    static encrypted(key: Uint8Array): SecureCookies {
        assertAesKeyLen(key);
        return new SecureCookies(MODE_ENCRYPTED, key);
    }

    /** Add a fallback key for rotation: sealing uses the first key, opening tries all. */
    addKey(key: Uint8Array): SecureCookies {
        if (this.mode == MODE_ENCRYPTED) assertAesKeyLen(key);
        this.keys.push(key);
        return this;
    }

    // --- key import (fresh per op: handles are per-request in the host) -----

    private importHmac(key: Uint8Array): CryptoKey {
        return crypto.subtle.importKey(
            'raw',
            key,
            new HmacImportParams(ALG_SHA_256),
            false,
            USAGE_SIGN | USAGE_VERIFY,
        );
    }

    private importAes(key: Uint8Array): CryptoKey {
        return crypto.subtle.importKey(
            'raw',
            key,
            new AesKeyParams(),
            false,
            USAGE_ENCRYPT | USAGE_DECRYPT,
        );
    }

    // --- signing ------------------------------------------------------------

    /** Return the signed (name-bound) sealed value for `name=value`. */
    sign(name: string, value: string): string {
        const k = this.importHmac(this.keys[0]);
        const mac = crypto.subtle.sign(new HmacParams(), k, utf8(name + '=' + value));
        return base64UrlEncode(utf8(value)) + '.' + base64UrlEncode(mac);
    }

    /** Verify a signed value for `name`, returning the plaintext or `null`. */
    unsign(name: string, sealed: string): string | null {
        const dot = sealed.lastIndexOf('.');
        if (dot < 0) return null;

        const valBytes = base64UrlDecode(sealed.substring(0, dot));
        const macBytes = base64UrlDecode(sealed.substring(dot + 1));
        if (valBytes == null || macBytes == null) return null;

        const value = fromUtf8(valBytes);
        const msg = utf8(name + '=' + value);
        for (let i = 0; i < this.keys.length; i++) {
            const k = this.importHmac(this.keys[i]);
            // HMAC verify returns false (not an error) on mismatch -> no throw.
            if (crypto.subtle.verify(new HmacParams(), k, macBytes, msg)) return value;
        }
        return null;
    }

    // --- encryption ---------------------------------------------------------

    /** Return the AES-GCM-encrypted sealed value for `name` / `value`. */
    encrypt(name: string, value: string): string {
        const iv = new Uint8Array(IV_LEN);
        crypto.getRandomValues(iv);

        const k = this.importAes(this.keys[0]);
        const ct = crypto.subtle.encrypt(new AesGcmParams(iv, utf8(name), 128), k, utf8(value));

        const sealed = new Uint8Array(IV_LEN + ct.length);
        for (let i = 0; i < IV_LEN; i++) sealed[i] = iv[i];
        for (let i = 0; i < ct.length; i++) sealed[IV_LEN + i] = ct[i];
        return base64UrlEncode(sealed);
    }

    /** Decrypt a sealed value for `name`, returning the plaintext or `null`. */
    decrypt(name: string, sealed: string): string | null {
        const raw = base64UrlDecode(sealed);
        if (raw == null) return null;
        if (raw.length < IV_LEN + TAG_LEN) return null; // need IV + at least the tag

        const iv = new Uint8Array(IV_LEN);
        for (let i = 0; i < IV_LEN; i++) iv[i] = raw[i];
        const data = raw.subarray(IV_LEN);
        const aad = utf8(name);

        for (let i = 0; i < this.keys.length; i++) {
            const k = this.importAes(this.keys[i]);
            const params = new AesGcmParams(iv, aad, 128).pack();
            // Raw host call: a bad tag / wrong key returns a negative code, which
            // we turn into `null`. Going through `subtle.decrypt` would throw and
            // (exceptions being disabled) abort the request.
            const len = webcrypto.decrypt(
                k.handle,
                params.dataStart,
                params.byteLength,
                data.dataStart,
                data.byteLength,
            );
            if (len >= 0) {
                const out = new Uint8Array(len);
                if (len > 0) webcrypto.takeResult(out.dataStart, len);
                return fromUtf8(out);
            }
        }
        return null;
    }

    // --- cookie helpers -----------------------------------------------------

    /**
     * Seal `cookie`'s value in place (sign or encrypt per this instance's mode)
     * and mark it `Raw` (the sealed value is already cookie-safe base64url).
     * Returns the same cookie for chaining.
     */
    seal(cookie: Cookie): Cookie {
        cookie.value =
            this.mode == MODE_ENCRYPTED
                ? this.encrypt(cookie.name, cookie.value)
                : this.sign(cookie.name, cookie.value);
        cookie.encoding = CookieEncoding.Raw;
        return cookie;
    }

    /** Read and open cookie `name` from a parsed jar, or `null` if missing/invalid. */
    open(jar: CookieMap, name: string): string | null {
        const sealed = jar.get(name);
        if (sealed == null) return null;
        return this.mode == MODE_ENCRYPTED ? this.decrypt(name, sealed) : this.unsign(name, sealed);
    }
}

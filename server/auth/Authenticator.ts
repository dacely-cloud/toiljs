import { base64UrlEncode } from 'toiljs/server/runtime';
import { HmacImportParams, HmacParams, ALG_SHA_1, FMT_RAW, USAGE_SIGN, CryptoKey, AlgorithmParams, AesGcmParams, ALG_AES_GCM, USAGE_ENCRYPT, USAGE_DECRYPT } from 'crypto';
import { DataWriter } from 'data';
import { webcrypto } from 'bindings/webcrypto';
import { AuthStateDb, FactorKey, TotpCounter } from './AuthStateDb';

@external('env', 'crypto.totp_verify')
declare function verifyTotp(secret: usize, size: i32, code: usize, length: i32, step: i64): i64;

class AesImport extends AlgorithmParams {
    serialize(w: DataWriter): void { w.writeI32(ALG_AES_GCM); w.writeI32(0); }
}

/** RFC 6238: Google Authenticator's SHA1 / 6 digits / 30 seconds profile. */
export class Authenticator {
    static base32(bytes: Uint8Array): string {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits: i32 = 0, value: u32 = 0;
        let result = '';
        for (let i = 0; i < bytes.length; i++) {
            value = (value << 8) | bytes[i]; bits += 8;
            while (bits >= 5) { bits -= 5; result += alphabet.charAt((value >> bits) & 31); }
        }
        if (bits > 0) result += alphabet.charAt((value << (5 - bits)) & 31);
        return result;
    }
    private static key(): CryptoKey {
        const value = Environment.getSecure('AUTH_SESSION_SECRET');
        if (value == null || value.length < 32) throw new Error('Authenticator requires AUTH_SESSION_SECRET');
        const key = crypto.sha256Text('toil-totp-encryption-v1\x00' + value);
        return crypto.subtle.importKey(FMT_RAW, key, new AesImport(), false, USAGE_ENCRYPT | USAGE_DECRYPT);
    }
    static seal(binding: Uint8Array, secret: Uint8Array): Uint8Array {
        const iv = new Uint8Array(12); crypto.getRandomValues(iv);
        const aad = binding;
        const ciphertext = crypto.subtle.encrypt(new AesGcmParams(iv, aad, 128), Authenticator.key(), secret);
        const sealed = new Uint8Array(12 + ciphertext.length);
        sealed.set(iv); sealed.set(ciphertext, 12); return sealed;
    }
    static open(binding: Uint8Array, sealed: Uint8Array): Uint8Array | null {
        if (sealed.length != 48) return null;
        const aad = binding;
        const params = new AesGcmParams(sealed.subarray(0, 12), aad, 128).pack();
        const data = sealed.subarray(12);
        const size = webcrypto.decrypt(Authenticator.key().handle, params.dataStart, params.length, data.dataStart, data.length);
        if (size != 20) return null;
        const secret = new Uint8Array(size); webcrypto.takeResult(secret.dataStart, size); return secret;
    }
    static code(secret: Uint8Array, step: u64): string {
        const bytes = new Uint8Array(8);
        for (let i = 7; i >= 0; i--) { bytes[i] = <u8>step; step >>= 8; }
        const key = crypto.subtle.importKey(FMT_RAW, secret, new HmacImportParams(ALG_SHA_1), false, USAGE_SIGN);
        const hash = crypto.subtle.sign(new HmacParams(), key, bytes);
        const o = hash[19] & 15;
        const n = ((<u32>hash[o] & 127) << 24) | (<u32>hash[o + 1] << 16) | (<u32>hash[o + 2] << 8) | hash[o + 3];
        let code = (n % 1000000).toString();
        while (code.length < 6) code = '0' + code;
        return code;
    }
    static match(binding: Uint8Array, sealed: Uint8Array, code: string): u64 {
        if (code.length != 6) return 0;
        for (let i = 0; i < 6; i++) if (code.charCodeAt(i) < 48 || code.charCodeAt(i) > 57) return 0;
        const secret = Authenticator.open(binding, sealed);
        if (secret == null) return 0;
        const bytes = Uint8Array.wrap(String.UTF8.encode(code));
        const matched = verifyTotp(secret.dataStart, secret.length, bytes.dataStart, bytes.length, <i64>(Date.now() / 30000));
        secret.fill(0);
        return matched > 0 ? <u64>matched : 0;
    }

    // An authenticated, randomized 256-bit ciphertext prefix identifies the enrollment.
    // No extra hash or per-verification token row is needed.

    /** Fresh randomized enrollment ciphertext: reserve its first step without a preceding read. */
    static initialize(host: string, sealed: Uint8Array, step: u64): bool {
        if (step == 0) return false;
        const key = new FactorKey(host, base64UrlEncode(sealed.subarray(12, 44)));
        const next = new TotpCounter(); next.step = step;
        return AuthStateDb.totpCounters.compareExchange(key, null, next);
    }

    /** One linearizable monotonic counter per enrollment, never one row per code. */
    static consume(host: string, sealed: Uint8Array, step: u64): bool {
        if (step == 0) return false;
        const key = new FactorKey(host, base64UrlEncode(sealed.subarray(12, 44)));
        const observed = AuthStateDb.totpCounters.getCurrentSnapshot(key);
        if (observed == null && Db.lastError() != DbError.None) throw new Error('Authenticator state unavailable');
        if (observed != null && observed.value.step >= step) return false;
        const next = new TotpCounter(); next.step = step;
        return observed == null ? AuthStateDb.totpCounters.compareExchange(key, null, next) :
            AuthStateDb.totpCounters.compareExchangeSnapshot(key, observed, next);
    }
}

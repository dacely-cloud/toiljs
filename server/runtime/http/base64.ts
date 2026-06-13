/**
 * base64url (RFC 4648 §5), unpadded. The toilscript std ships `Encoding.Hex`
 * and `Encoding.Varint` but no base64, and `SecureCookies` needs a compact,
 * cookie-safe transport for raw bytes (IV ‖ ciphertext ‖ tag, or an HMAC).
 *
 * base64url is a deliberate fit for cookies: its alphabet
 * (`A-Z a-z 0-9 - _`) is entirely within the RFC 6265bis `cookie-octet` set
 * and is invariant under percent-encoding, so a sealed value round-trips
 * cleanly through the default cookie encoder/decoder untouched.
 *
 * Internal to the cookie library (not a global).
 */

const ALPHABET: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encode `data` as unpadded base64url. */
export function base64UrlEncode(data: Uint8Array): string {
    const n = data.length;
    if (n == 0) return '';

    let out = '';
    let i = 0;
    while (i + 3 <= n) {
        const b0 = <i32>data[i];
        const b1 = <i32>data[i + 1];
        const b2 = <i32>data[i + 2];
        out += ALPHABET.charAt(b0 >> 2);
        out += ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4));
        out += ALPHABET.charAt(((b1 & 15) << 2) | (b2 >> 6));
        out += ALPHABET.charAt(b2 & 63);
        i += 3;
    }

    const rem = n - i;
    if (rem == 1) {
        const b0 = <i32>data[i];
        out += ALPHABET.charAt(b0 >> 2);
        out += ALPHABET.charAt((b0 & 3) << 4);
    } else if (rem == 2) {
        const b0 = <i32>data[i];
        const b1 = <i32>data[i + 1];
        out += ALPHABET.charAt(b0 >> 2);
        out += ALPHABET.charAt(((b0 & 3) << 4) | (b1 >> 4));
        out += ALPHABET.charAt((b1 & 15) << 2);
    }
    return out;
}

/** Decode a single base64url (or base64) sextet character, or -1 if invalid. */
function sextet(c: i32): i32 {
    if (c >= 65 && c <= 90) return c - 65; // A-Z
    if (c >= 97 && c <= 122) return c - 97 + 26; // a-z
    if (c >= 48 && c <= 57) return c - 48 + 52; // 0-9
    if (c == 45 || c == 43) return 62; // '-' (url) or '+' (standard)
    if (c == 95 || c == 47) return 63; // '_' (url) or '/' (standard)
    return -1;
}

/**
 * Decode unpadded (or padded) base64url/base64 into bytes, or `null` if the
 * input contains an invalid character or has an impossible length. `=` padding
 * and ASCII whitespace are tolerated and ignored.
 */
export function base64UrlDecode(s: string): Uint8Array | null {
    const vals = new Array<i32>();
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c == 61 || c == 32 || c == 9 || c == 10 || c == 13) continue; // '=' or WS
        const v = sextet(c);
        if (v < 0) return null;
        vals.push(v);
    }

    const nq = vals.length;
    const rem = nq & 3;
    if (rem == 1) return null; // a single trailing sextet can't exist

    const outLen = (nq * 6) / 8;
    const out = new Uint8Array(outLen);
    let oi = 0;
    let i = 0;
    while (i + 4 <= nq) {
        const v0 = vals[i];
        const v1 = vals[i + 1];
        const v2 = vals[i + 2];
        const v3 = vals[i + 3];
        out[oi++] = <u8>(((v0 << 2) | (v1 >> 4)) & 0xff);
        out[oi++] = <u8>(((v1 << 4) | (v2 >> 2)) & 0xff);
        out[oi++] = <u8>(((v2 << 6) | v3) & 0xff);
        i += 4;
    }
    if (rem == 2) {
        const v0 = vals[i];
        const v1 = vals[i + 1];
        out[oi++] = <u8>(((v0 << 2) | (v1 >> 4)) & 0xff);
    } else if (rem == 3) {
        const v0 = vals[i];
        const v1 = vals[i + 1];
        const v2 = vals[i + 2];
        out[oi++] = <u8>(((v0 << 2) | (v1 >> 4)) & 0xff);
        out[oi++] = <u8>(((v1 << 4) | (v2 >> 2)) & 0xff);
    }
    return out;
}

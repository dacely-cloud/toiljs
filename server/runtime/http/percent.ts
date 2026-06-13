/**
 * Percent-encoding for cookie values, matching `encodeURIComponent` /
 * `decodeURIComponent` semantics (the de-facto default of Node's `cookie`
 * package). The unreserved set (`A-Z a-z 0-9 - _ . ! ~ * ' ( )`) is a subset of
 * the RFC 6265bis `cookie-octet` grammar, so the output is always a valid
 * unquoted cookie value and arbitrary UTF-8 round-trips safely.
 *
 * Internal to the cookie library (not a global); surfaced through
 * `Cookies.encodeValue` / `Cookies.decodeValue`.
 */

const HEX: string = '0123456789ABCDEF';

function isUnreserved(c: i32): bool {
    if (c >= 65 && c <= 90) return true; // A-Z
    if (c >= 97 && c <= 122) return true; // a-z
    if (c >= 48 && c <= 57) return true; // 0-9
    // - _ . ! ~ * ' ( )
    return (
        c == 45 || c == 95 || c == 46 || c == 33 || c == 126 ||
        c == 42 || c == 39 || c == 40 || c == 41
    );
}

function hexVal(c: i32): i32 {
    if (c >= 48 && c <= 57) return c - 48; // 0-9
    if (c >= 65 && c <= 70) return c - 55; // A-F
    if (c >= 97 && c <= 102) return c - 87; // a-f
    return -1;
}

/** Percent-encode `s` (UTF-8) into a cookie-safe value. */
export function percentEncode(s: string): string {
    const bytes = Uint8Array.wrap(String.UTF8.encode(s));
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const c = <i32>bytes[i];
        if (isUnreserved(c)) {
            out += String.fromCharCode(c);
        } else {
            out += '%';
            out += HEX.charAt(c >> 4);
            out += HEX.charAt(c & 15);
        }
    }
    return out;
}

/**
 * Reverse {@link percentEncode}. A `%` not followed by two hex digits is kept
 * literally (lenient, never throws). `+` is preserved as-is (cookies are not
 * form-encoded, so `+` is not a space).
 */
export function percentDecode(s: string): string {
    const n = s.length;
    const bytes = new Array<u8>();
    let i = 0;
    while (i < n) {
        const c = s.charCodeAt(i);
        if (c == 37 && i + 2 < n) {
            // '%'
            const hi = hexVal(s.charCodeAt(i + 1));
            const lo = hexVal(s.charCodeAt(i + 2));
            if (hi >= 0 && lo >= 0) {
                bytes.push(<u8>((hi << 4) | lo));
                i += 3;
                continue;
            }
        }
        bytes.push(<u8>(c & 0xff));
        i++;
    }
    const arr = new Uint8Array(bytes.length);
    for (let j = 0; j < bytes.length; j++) arr[j] = bytes[j];
    return String.UTF8.decodeUnsafe(arr.dataStart, arr.byteLength);
}

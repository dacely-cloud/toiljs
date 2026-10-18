// Generated from server/runtime by scripts/gen-server-types.mjs.
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
/** Encode `data` as unpadded base64url. */
export declare function base64UrlEncode(data: Uint8Array): string;
/**
 * Decode unpadded (or padded) base64url/base64 into bytes, or `null` if the
 * input contains an invalid character or has an impossible length. `=` padding
 * and ASCII whitespace are tolerated and ignored.
 */
export declare function base64UrlDecode(s: string): Uint8Array | null;

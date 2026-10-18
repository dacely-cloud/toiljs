// Generated from server/runtime by scripts/gen-server-types.mjs.
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
/** Percent-encode `s` (UTF-8) into a cookie-safe value. */
export declare function percentEncode(s: string): string;
/**
 * Reverse {@link percentEncode}. A `%` not followed by two hex digits is kept
 * literally (lenient, never throws). `+` is preserved as-is (cookies are not
 * form-encoded, so `+` is not a space).
 */
export declare function percentDecode(s: string): string;

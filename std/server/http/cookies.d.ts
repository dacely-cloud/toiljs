// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * `Cookies` — parsing and codec helpers, and `CookieMap`, the result of parsing
 * a request `Cookie` header. The write side (building a `Set-Cookie`) lives on
 * the {@link Cookie} builder; this is the read side plus a one-shot serializer.
 *
 * Both `Cookies` and `CookieMap` are ambient globals (`@global`, no import) and
 * are also exported from `toiljs/server/runtime`.
 */
import { Cookie } from './cookie';
/**
 * An ordered, name→value view of the cookies on a request. Backed by parallel
 * arrays (a request carries a handful of cookies; the linear scan beats hashing
 * and keeps the codec-free runtime small, matching `RouteContext`). On a
 * duplicate name the first occurrence wins (it is the most specific per
 * RFC 6265bis ordering).
 */
export declare class CookieMap {
    private keys;
    private vals;
    /** Insert unless `name` is already present (keep-first). */
    set(name: string, value: string): void;
    /** The value for `name`, or `null` if absent. */
    get(name: string): string | null;
    has(name: string): bool;
    /** A copy of the cookie names, in encounter order. */
    names(): Array<string>;
    get size(): i32;
}
export declare class Cookies {
    /**
     * Parse a request `Cookie` header (`a=1; b=2`) into a {@link CookieMap}.
     * Values are percent-decoded (the inverse of the default `Cookie` encoding)
     * and one layer of surrounding quotes is stripped. Malformed pairs and
     * empty names are skipped, never thrown.
     */
    static parse(cookieHeader: string): CookieMap;
    /** Shorthand: parse `cookieHeader` and return the value for `name`, or `null`. */
    static get(cookieHeader: string, name: string): string | null;
    /**
     * One-shot `Set-Cookie` value for `name=value` with no attributes
     * (percent-encoded). For attributes, build a {@link Cookie} and call
     * `cookie.serialize()`.
     */
    static serialize(name: string, value: string): string;
    /**
     * Parse a `Set-Cookie` field value back into a {@link Cookie} (for clients,
     * tests, or proxies). The value is kept verbatim (`CookieEncoding.Raw`) so
     * re-serializing reproduces the original wire form.
     */
    static parseSetCookie(setCookie: string): Cookie;
    /** Percent-encode a value as the default `Cookie` encoding would. */
    static encodeValue(raw: string): string;
    /** Percent-decode a value (the inverse of {@link encodeValue}). */
    static decodeValue(enc: string): string;
}

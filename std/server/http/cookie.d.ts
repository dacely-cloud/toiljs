// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * `Cookie` — a fluent builder, serializer, and validator for a single
 * `Set-Cookie`, covering the full RFC 6265bis attribute set plus the
 * `Partitioned` (CHIPS) and `Priority` attributes.
 *
 * Exposed as an ambient global (`@global`, no import needed in a handler) and
 * also exported from `toiljs/server/runtime`. Pairs with `Cookies` (parsing /
 * the request side) and `SecureCookies` (signing / encryption).
 *
 * ```ts
 * resp.setCookie(
 *   Cookie.create('sid', token)
 *     .httpOnly()
 *     .secure()
 *     .sameSite(SameSite.Lax)
 *     .maxAge(3600)
 *     .asHostPrefixed(),
 * );
 * ```
 */
/** `SameSite` attribute. `Default` omits the attribute (the UA applies Lax). */
export declare enum SameSite {
    Default = 0,
    None = 1,
    Lax = 2,
    Strict = 3
}
/** How a cookie value is encoded onto the wire. */
export declare enum CookieEncoding {
    /** `encodeURIComponent`-style percent-encoding (default): arbitrary UTF-8 is safe. */
    Percent = 0,
    /** No transformation. The value must already be valid `cookie-octet`. */
    Raw = 1,
    /** UTF-8 then unpadded base64url. */
    Base64Url = 2
}
/** Cookie name prefix with browser-enforced guarantees (RFC 6265bis §4.1.3). */
export declare enum CookiePrefix {
    None = 0,
    /** `__Secure-`: requires `Secure`. */
    Secure = 1,
    /** `__Host-`: requires `Secure`, `Path=/`, and no `Domain`. */
    Host = 2
}
/** SHOULD-NOT-exceed lifetime cap from RFC 6265bis §5.5: 400 days, in seconds. */
export declare const MAX_LIFETIME_SECONDS: i64;
/** RFC 6265bis `cookie-octet`: %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E. */
export declare function isCookieOctet(c: i32): bool;
/** Result of {@link Cookie#validate}: `valid` plus the list of problems found. */
export declare class CookieValidation {
    valid: bool;
    errors: Array<string>;
    fail(msg: string): void;
}
export declare class Cookie {
    /** Cookie name (a token; never encoded). */
    name: string;
    /** Logical cookie value (encoded per {@link encoding} on serialize). */
    value: string;
    /** Wire encoding applied to {@link value} by {@link serialize}. */
    encoding: CookieEncoding;
    private _domain;
    private _path;
    private _maxAge;
    private _hasMaxAge;
    private _expires;
    private _hasExpires;
    private _expiresRaw;
    private _secure;
    private _httpOnly;
    private _sameSite;
    private _partitioned;
    private _priority;
    private _extensions;
    constructor(name: string, value: string);
    /** Construct a cookie. Builder-style alias for `new Cookie(name, value)`. */
    static create(name: string, value: string): Cookie;
    /** `Domain` attribute. */
    domain(v: string): Cookie;
    /** `Path` attribute (must begin with `/`). */
    path(v: string): Cookie;
    /** `Max-Age` in seconds. `0` / negative expire the cookie immediately. */
    maxAge(seconds: i64): Cookie;
    /** `Expires` from a Unix timestamp (seconds), formatted as an IMF-fixdate. */
    expires(epochSeconds: i64): Cookie;
    /** `Expires` as a verbatim date string (escape hatch; not validated). */
    expiresRaw(date: string): Cookie;
    /** `Secure` attribute. */
    secure(on?: bool): Cookie;
    /** `HttpOnly` attribute. */
    httpOnly(on?: bool): Cookie;
    /** `SameSite` attribute. */
    sameSite(s: SameSite): Cookie;
    /** `Partitioned` attribute (CHIPS). Implies `Secure` on serialize. */
    partitioned(on?: bool): Cookie;
    /** `Priority` attribute (`Low` / `Medium` / `High`). */
    priority(p: string): Cookie;
    /** Append a raw extension attribute verbatim, e.g. `extension('CustomFlag')`. */
    extension(av: string): Cookie;
    /** Choose the wire encoding for the value. */
    withEncoding(e: CookieEncoding): Cookie;
    /** Apply the `__Secure-` prefix and force `Secure`. */
    asSecurePrefixed(): Cookie;
    /** Apply the `__Host-` prefix and force `Secure`, `Path=/`, and no `Domain`. */
    asHostPrefixed(): Cookie;
    /** SameSite=None and Partitioned both require Secure; reflect that here. */
    private effectiveSecure;
    /** The name prefix detected case-insensitively (RFC 6265bis §5.4). */
    detectedPrefix(): CookiePrefix;
    /** The value transformed per {@link encoding}, ready for the wire. */
    encodedValue(): string;
    /**
     * Validate against RFC 6265bis: name token, name+value ≤ 4096 bytes,
     * attribute sizes, `Path` form, prefix guarantees, `SameSite=None`/
     * `Partitioned` ⇒ `Secure`, and the 400-day lifetime cap.
     */
    validate(): CookieValidation;
    /**
     * Serialize to a `Set-Cookie` field value. Lenient by default (always emits
     * a best-effort cookie); pass `strict = true` to throw on a hard violation.
     * `Secure` is emitted automatically when `SameSite=None` or `Partitioned` is
     * set, and `Max-Age` is clamped to the 400-day cap.
     */
    serialize(strict?: bool): string;
    toString(): string;
}

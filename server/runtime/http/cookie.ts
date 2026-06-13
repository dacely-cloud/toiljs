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

import { imfFixdate } from './date';
import { base64UrlEncode } from './base64';
import { percentEncode } from './percent';

/** `SameSite` attribute. `Default` omits the attribute (the UA applies Lax). */
@global
export enum SameSite {
    Default = 0,
    None = 1,
    Lax = 2,
    Strict = 3,
}

/** How a cookie value is encoded onto the wire. */
@global
export enum CookieEncoding {
    /** `encodeURIComponent`-style percent-encoding (default): arbitrary UTF-8 is safe. */
    Percent = 0,
    /** No transformation. The value must already be valid `cookie-octet`. */
    Raw = 1,
    /** UTF-8 then unpadded base64url. */
    Base64Url = 2,
}

/** Cookie name prefix with browser-enforced guarantees (RFC 6265bis §4.1.3). */
@global
export enum CookiePrefix {
    None = 0,
    /** `__Secure-`: requires `Secure`. */
    Secure = 1,
    /** `__Host-`: requires `Secure`, `Path=/`, and no `Domain`. */
    Host = 2,
}

/** SHOULD-NOT-exceed lifetime cap from RFC 6265bis §5.5: 400 days, in seconds. */
export const MAX_LIFETIME_SECONDS: i64 = 34560000;

// --- grammar predicates -----------------------------------------------------

/** RFC 7230 `token` char: ALPHA / DIGIT / "!#$%&'*+-.^_`|~". */
function isTokenChar(c: i32): bool {
    if (c >= 65 && c <= 90) return true; // A-Z
    if (c >= 97 && c <= 122) return true; // a-z
    if (c >= 48 && c <= 57) return true; // 0-9
    return (
        c == 33 || c == 35 || c == 36 || c == 37 || c == 38 || c == 39 ||
        c == 42 || c == 43 || c == 45 || c == 46 || c == 94 || c == 95 ||
        c == 96 || c == 124 || c == 126
    );
}

function isToken(s: string): bool {
    if (s.length == 0) return false;
    for (let i = 0; i < s.length; i++) {
        if (!isTokenChar(s.charCodeAt(i))) return false;
    }
    return true;
}

/** RFC 6265bis `cookie-octet`: %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E. */
export function isCookieOctet(c: i32): bool {
    return (
        c == 0x21 ||
        (c >= 0x23 && c <= 0x2b) ||
        (c >= 0x2d && c <= 0x3a) ||
        (c >= 0x3c && c <= 0x5b) ||
        (c >= 0x5d && c <= 0x7e)
    );
}

function allCookieOctet(s: string): bool {
    for (let i = 0; i < s.length; i++) {
        if (!isCookieOctet(s.charCodeAt(i))) return false;
    }
    return true;
}

/**
 * Keep only RFC 7230 `token` characters. A cookie name MUST be a token, so this
 * drops anything (CR/LF, `;`, `=`, whitespace, ...) that could break out of the
 * name and inject an attribute or a header. Fast path returns a clean input as-is.
 */
function tokenize(s: string): string {
    let clean = true;
    for (let i = 0; i < s.length; i++) {
        if (!isTokenChar(s.charCodeAt(i))) {
            clean = false;
            break;
        }
    }
    if (clean) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (isTokenChar(c)) out += String.fromCharCode(c);
    }
    return out;
}

/**
 * Strip the characters that could break out of a value or attribute on the wire:
 * control characters (C0 + DEL), which enable CR/LF header injection, and `;`,
 * which would otherwise start a new cookie attribute. Defense in depth: the
 * default percent encoding already removes these from the value, and they are
 * invalid in these positions per the cookie grammar, so nothing legitimate is
 * lost (base64url sealed values are unaffected). Fast path returns a clean input.
 */
function stripUnsafe(s: string): string {
    let clean = true;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c == 0x7f || c == 0x3b) {
            clean = false;
            break;
        }
    }
    if (clean) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0x20 && c != 0x7f && c != 0x3b) out += String.fromCharCode(c);
    }
    return out;
}

/** Result of {@link Cookie#validate}: `valid` plus the list of problems found. */
export class CookieValidation {
    valid: bool = true;
    errors: Array<string> = new Array<string>();

    fail(msg: string): void {
        this.valid = false;
        this.errors.push(msg);
    }
}

@global
export class Cookie {
    /** Cookie name (a token; never encoded). */
    name: string;
    /** Logical cookie value (encoded per {@link encoding} on serialize). */
    value: string;
    /** Wire encoding applied to {@link value} by {@link serialize}. */
    encoding: CookieEncoding = CookieEncoding.Percent;

    private _domain: string = '';
    private _path: string = '';
    private _maxAge: i64 = 0;
    private _hasMaxAge: bool = false;
    private _expires: i64 = 0;
    private _hasExpires: bool = false;
    private _expiresRaw: string = '';
    private _secure: bool = false;
    private _httpOnly: bool = false;
    private _sameSite: SameSite = SameSite.Default;
    private _partitioned: bool = false;
    private _priority: string = '';
    private _extensions: Array<string> = new Array<string>();

    constructor(name: string, value: string) {
        this.name = name;
        this.value = value;
    }

    /** Construct a cookie. Builder-style alias for `new Cookie(name, value)`. */
    static create(name: string, value: string): Cookie {
        return new Cookie(name, value);
    }

    // --- fluent attribute setters (each returns `this`) ---------------------

    /** `Domain` attribute. */
    domain(v: string): Cookie {
        this._domain = v;
        return this;
    }

    /** `Path` attribute (must begin with `/`). */
    path(v: string): Cookie {
        this._path = v;
        return this;
    }

    /** `Max-Age` in seconds. `0` / negative expire the cookie immediately. */
    maxAge(seconds: i64): Cookie {
        this._maxAge = seconds;
        this._hasMaxAge = true;
        return this;
    }

    /** `Expires` from a Unix timestamp (seconds), formatted as an IMF-fixdate. */
    expires(epochSeconds: i64): Cookie {
        this._expires = epochSeconds;
        this._hasExpires = true;
        return this;
    }

    /** `Expires` as a verbatim date string (escape hatch; not validated). */
    expiresRaw(date: string): Cookie {
        this._expiresRaw = date;
        return this;
    }

    /** `Secure` attribute. */
    secure(on: bool = true): Cookie {
        this._secure = on;
        return this;
    }

    /** `HttpOnly` attribute. */
    httpOnly(on: bool = true): Cookie {
        this._httpOnly = on;
        return this;
    }

    /** `SameSite` attribute. */
    sameSite(s: SameSite): Cookie {
        this._sameSite = s;
        return this;
    }

    /** `Partitioned` attribute (CHIPS). Implies `Secure` on serialize. */
    partitioned(on: bool = true): Cookie {
        this._partitioned = on;
        return this;
    }

    /** `Priority` attribute (`Low` / `Medium` / `High`). */
    priority(p: string): Cookie {
        this._priority = p;
        return this;
    }

    /** Append a raw extension attribute verbatim, e.g. `extension('CustomFlag')`. */
    extension(av: string): Cookie {
        this._extensions.push(av);
        return this;
    }

    /** Choose the wire encoding for the value. */
    withEncoding(e: CookieEncoding): Cookie {
        this.encoding = e;
        return this;
    }

    // --- prefixes -----------------------------------------------------------

    /** Apply the `__Secure-` prefix and force `Secure`. */
    asSecurePrefixed(): Cookie {
        if (this.name.indexOf('__Secure-') != 0) this.name = '__Secure-' + this.name;
        this._secure = true;
        return this;
    }

    /** Apply the `__Host-` prefix and force `Secure`, `Path=/`, and no `Domain`. */
    asHostPrefixed(): Cookie {
        if (this.name.indexOf('__Host-') != 0) this.name = '__Host-' + this.name;
        this._secure = true;
        this._path = '/';
        this._domain = '';
        return this;
    }

    // --- helpers ------------------------------------------------------------

    /** SameSite=None and Partitioned both require Secure; reflect that here. */
    private effectiveSecure(): bool {
        return this._secure || this._sameSite == SameSite.None || this._partitioned;
    }

    /** The name prefix detected case-insensitively (RFC 6265bis §5.4). */
    detectedPrefix(): CookiePrefix {
        const lower = this.name.toLowerCase();
        if (lower.startsWith('__host-')) return CookiePrefix.Host;
        if (lower.startsWith('__secure-')) return CookiePrefix.Secure;
        return CookiePrefix.None;
    }

    /** The value transformed per {@link encoding}, ready for the wire. */
    encodedValue(): string {
        if (this.encoding == CookieEncoding.Raw) return this.value;
        if (this.encoding == CookieEncoding.Base64Url) {
            return base64UrlEncode(Uint8Array.wrap(String.UTF8.encode(this.value)));
        }
        return percentEncode(this.value);
    }

    /**
     * Validate against RFC 6265bis: name token, name+value ≤ 4096 bytes,
     * attribute sizes, `Path` form, prefix guarantees, `SameSite=None`/
     * `Partitioned` ⇒ `Secure`, and the 400-day lifetime cap.
     */
    validate(): CookieValidation {
        const v = new CookieValidation();

        if (!isToken(this.name)) {
            v.fail('invalid cookie name (must be a non-empty RFC token): "' + this.name + '"');
        }

        const enc = this.encodedValue();
        if (String.UTF8.byteLength(this.name) + String.UTF8.byteLength(enc) > 4096) {
            v.fail('cookie name+value exceeds the 4096-byte limit');
        }
        if (this.encoding == CookieEncoding.Raw && !allCookieOctet(enc)) {
            v.fail('raw cookie value contains characters outside cookie-octet');
        }

        if (this._domain.length > 0 && String.UTF8.byteLength(this._domain) > 1024) {
            v.fail('Domain exceeds the 1024-byte limit');
        }
        if (this._path.length > 0) {
            if (!this._path.startsWith('/')) v.fail("Path must start with '/'");
            if (String.UTF8.byteLength(this._path) > 1024) v.fail('Path exceeds the 1024-byte limit');
        }

        const prefix = this.detectedPrefix();
        const secure = this.effectiveSecure();
        if (prefix == CookiePrefix.Secure && !secure) {
            v.fail('__Secure- prefix requires the Secure attribute');
        }
        if (prefix == CookiePrefix.Host) {
            if (!secure) v.fail('__Host- prefix requires the Secure attribute');
            if (this._domain.length > 0) v.fail('__Host- prefix forbids the Domain attribute');
            if (this._path != '/') v.fail('__Host- prefix requires Path=/');
        }
        if (this._sameSite == SameSite.None && !secure) {
            v.fail('SameSite=None requires the Secure attribute');
        }
        if (this._partitioned && !secure) {
            v.fail('Partitioned requires the Secure attribute');
        }
        if (this._hasMaxAge && this._maxAge > MAX_LIFETIME_SECONDS) {
            v.fail('Max-Age exceeds the 400-day cap (clamped on serialize)');
        }

        return v;
    }

    /**
     * Serialize to a `Set-Cookie` field value. Lenient by default (always emits
     * a best-effort cookie); pass `strict = true` to throw on a hard violation.
     * `Secure` is emitted automatically when `SameSite=None` or `Partitioned` is
     * set, and `Max-Age` is clamped to the 400-day cap.
     */
    serialize(strict: bool = false): string {
        if (strict) {
            const v = this.validate();
            if (!v.valid) {
                throw new Error('invalid cookie: ' + (v.errors.length > 0 ? v.errors[0] : 'unknown'));
            }
        }

        // Sanitize every caller-supplied part to its grammar as defense in depth
        // against header injection (CR/LF) and cookie-attribute injection (`;`).
        // The name is reduced to RFC token characters; values and attribute
        // values have controls and `;` stripped. These are invalid in these
        // positions per the cookie grammar, so nothing legitimate is dropped, and
        // base64url sealed values pass through untouched.
        let s = tokenize(this.name) + '=' + stripUnsafe(this.encodedValue());

        if (this._domain.length > 0) s += '; Domain=' + stripUnsafe(this._domain);
        if (this._path.length > 0) s += '; Path=' + stripUnsafe(this._path);

        if (this._expiresRaw.length > 0) {
            s += '; Expires=' + stripUnsafe(this._expiresRaw);
        } else if (this._hasExpires) {
            s += '; Expires=' + imfFixdate(this._expires);
        }

        if (this._hasMaxAge) {
            let age = this._maxAge;
            if (age > MAX_LIFETIME_SECONDS) age = MAX_LIFETIME_SECONDS;
            s += '; Max-Age=' + age.toString();
        }

        if (this._sameSite == SameSite.Strict) s += '; SameSite=Strict';
        else if (this._sameSite == SameSite.Lax) s += '; SameSite=Lax';
        else if (this._sameSite == SameSite.None) s += '; SameSite=None';

        if (this.effectiveSecure()) s += '; Secure';
        if (this._httpOnly) s += '; HttpOnly';
        if (this._partitioned) s += '; Partitioned';
        if (this._priority.length > 0) s += '; Priority=' + stripUnsafe(this._priority);

        for (let i = 0; i < this._extensions.length; i++) {
            s += '; ' + stripUnsafe(this._extensions[i]);
        }

        return s;
    }

    toString(): string {
        return this.serialize();
    }
}

/**
 * Editor-only ambient declarations for the toiljs cookie globals.
 *
 * `Cookie`, `Cookies`, `SecureCookies`, and the `SameSite` / `CookieEncoding` /
 * `CookiePrefix` enums are `@global` in the toiljs server runtime, so a handler
 * uses them with no import (exactly like `crypto`). The toilscript compiler
 * registers them from the runtime; this file just gives the editor their shapes
 * so it does not flag the unimported names. It is auto-included by the server
 * `tsconfig.json` (`include: ["./**/*.ts"]`) and ignored by the compiler.
 *
 * `toiljs create` scaffolds this file; keep it in sync with
 * `toiljs/server/runtime/http/*`.
 */

declare enum SameSite {
    Default = 0,
    None = 1,
    Lax = 2,
    Strict = 3,
}

declare enum CookieEncoding {
    Percent = 0,
    Raw = 1,
    Base64Url = 2,
}

declare enum CookiePrefix {
    None = 0,
    Secure = 1,
    Host = 2,
}

declare class CookieValidation {
    valid: bool;
    errors: Array<string>;
    fail(msg: string): void;
}

declare class Cookie {
    name: string;
    value: string;
    encoding: CookieEncoding;
    constructor(name: string, value: string);
    static create(name: string, value: string): Cookie;
    domain(v: string): Cookie;
    path(v: string): Cookie;
    maxAge(seconds: i64): Cookie;
    expires(epochSeconds: i64): Cookie;
    expiresRaw(date: string): Cookie;
    secure(on?: bool): Cookie;
    httpOnly(on?: bool): Cookie;
    sameSite(s: SameSite): Cookie;
    partitioned(on?: bool): Cookie;
    priority(p: string): Cookie;
    extension(av: string): Cookie;
    withEncoding(e: CookieEncoding): Cookie;
    asSecurePrefixed(): Cookie;
    asHostPrefixed(): Cookie;
    detectedPrefix(): CookiePrefix;
    encodedValue(): string;
    validate(): CookieValidation;
    serialize(strict?: bool): string;
    toString(): string;
}

declare class CookieMap {
    set(name: string, value: string): void;
    get(name: string): string | null;
    has(name: string): bool;
    names(): Array<string>;
    readonly size: i32;
}

declare class Cookies {
    static parse(cookieHeader: string): CookieMap;
    static get(cookieHeader: string, name: string): string | null;
    static serialize(name: string, value: string): string;
    static parseSetCookie(setCookie: string): Cookie;
    static encodeValue(raw: string): string;
    static decodeValue(enc: string): string;
}

declare class SecureCookies {
    static signed(key: Uint8Array): SecureCookies;
    static encrypted(key: Uint8Array): SecureCookies;
    addKey(key: Uint8Array): SecureCookies;
    sign(name: string, value: string): string;
    unsign(name: string, sealed: string): string | null;
    encrypt(name: string, value: string): string;
    decrypt(name: string, sealed: string): string | null;
    seal(cookie: Cookie): Cookie;
    open(jar: CookieMap, name: string): string | null;
}

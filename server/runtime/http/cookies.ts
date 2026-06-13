/**
 * `Cookies` — parsing and codec helpers, and `CookieMap`, the result of parsing
 * a request `Cookie` header. The write side (building a `Set-Cookie`) lives on
 * the {@link Cookie} builder; this is the read side plus a one-shot serializer.
 *
 * Both `Cookies` and `CookieMap` are ambient globals (`@global`, no import) and
 * are also exported from `toiljs/server/runtime`.
 */

import { Cookie, SameSite, CookieEncoding } from './cookie';
import { percentEncode, percentDecode } from './percent';

/** Parse a base-10 signed integer (leading `+`/`-`, then digits), lenient. */
function parseI64(s: string): i64 {
    let i = 0;
    let neg = false;
    if (s.length > 0 && (s.charCodeAt(0) == 45 || s.charCodeAt(0) == 43)) {
        neg = s.charCodeAt(0) == 45;
        i = 1;
    }
    let r: i64 = 0;
    for (; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57) break;
        r = r * 10 + <i64>(c - 48);
    }
    return neg ? -r : r;
}

/** Strip one layer of surrounding DQUOTEs, as servers conventionally do on read. */
function unquote(s: string): string {
    if (s.length >= 2 && s.charCodeAt(0) == 34 && s.charCodeAt(s.length - 1) == 34) {
        return s.substring(1, s.length - 1);
    }
    return s;
}

/**
 * An ordered, name→value view of the cookies on a request. Backed by parallel
 * arrays (a request carries a handful of cookies; the linear scan beats hashing
 * and keeps the codec-free runtime small, matching `RouteContext`). On a
 * duplicate name the first occurrence wins (it is the most specific per
 * RFC 6265bis ordering).
 */
@global
export class CookieMap {
    private keys: Array<string> = new Array<string>();
    private vals: Array<string> = new Array<string>();

    /** Insert unless `name` is already present (keep-first). */
    set(name: string, value: string): void {
        for (let i = 0; i < this.keys.length; i++) {
            if (this.keys[i] == name) return;
        }
        this.keys.push(name);
        this.vals.push(value);
    }

    /** The value for `name`, or `null` if absent. */
    get(name: string): string | null {
        for (let i = 0; i < this.keys.length; i++) {
            if (this.keys[i] == name) return this.vals[i];
        }
        return null;
    }

    has(name: string): bool {
        for (let i = 0; i < this.keys.length; i++) {
            if (this.keys[i] == name) return true;
        }
        return false;
    }

    /** A copy of the cookie names, in encounter order. */
    names(): Array<string> {
        const out = new Array<string>();
        for (let i = 0; i < this.keys.length; i++) out.push(this.keys[i]);
        return out;
    }

    get size(): i32 {
        return this.keys.length;
    }
}

@global
export class Cookies {
    /**
     * Parse a request `Cookie` header (`a=1; b=2`) into a {@link CookieMap}.
     * Values are percent-decoded (the inverse of the default `Cookie` encoding)
     * and one layer of surrounding quotes is stripped. Malformed pairs and
     * empty names are skipped, never thrown.
     */
    static parse(cookieHeader: string): CookieMap {
        const map = new CookieMap();
        if (cookieHeader.length == 0) return map;

        const parts = cookieHeader.split(';');
        for (let i = 0; i < parts.length; i++) {
            const pair = parts[i].trim();
            if (pair.length == 0) continue;

            const eq = pair.indexOf('=');
            let name: string;
            let rawVal: string;
            if (eq < 0) {
                name = pair;
                rawVal = '';
            } else {
                name = pair.substring(0, eq).trim();
                rawVal = pair.substring(eq + 1).trim();
            }
            if (name.length == 0) continue;

            map.set(name, percentDecode(unquote(rawVal)));
        }
        return map;
    }

    /** Shorthand: parse `cookieHeader` and return the value for `name`, or `null`. */
    static get(cookieHeader: string, name: string): string | null {
        return Cookies.parse(cookieHeader).get(name);
    }

    /**
     * One-shot `Set-Cookie` value for `name=value` with no attributes
     * (percent-encoded). For attributes, build a {@link Cookie} and call
     * `cookie.serialize()`.
     */
    static serialize(name: string, value: string): string {
        return new Cookie(name, value).serialize();
    }

    /**
     * Parse a `Set-Cookie` field value back into a {@link Cookie} (for clients,
     * tests, or proxies). The value is kept verbatim (`CookieEncoding.Raw`) so
     * re-serializing reproduces the original wire form.
     */
    static parseSetCookie(setCookie: string): Cookie {
        const parts = setCookie.split(';');
        const first = parts.length > 0 ? parts[0].trim() : '';
        const eq = first.indexOf('=');
        let name: string;
        let rawVal: string;
        if (eq < 0) {
            name = first;
            rawVal = '';
        } else {
            name = first.substring(0, eq).trim();
            rawVal = first.substring(eq + 1).trim();
        }

        const c = new Cookie(name, rawVal);
        c.encoding = CookieEncoding.Raw;

        for (let i = 1; i < parts.length; i++) {
            const av = parts[i].trim();
            if (av.length == 0) continue;
            const aeq = av.indexOf('=');
            let an: string;
            let avv: string;
            if (aeq < 0) {
                an = av.toLowerCase();
                avv = '';
            } else {
                an = av.substring(0, aeq).trim().toLowerCase();
                avv = av.substring(aeq + 1).trim();
            }

            if (an == 'domain') c.domain(avv);
            else if (an == 'path') c.path(avv);
            else if (an == 'max-age') c.maxAge(parseI64(avv));
            else if (an == 'expires') c.expiresRaw(avv);
            else if (an == 'samesite') {
                const lv = avv.toLowerCase();
                if (lv == 'strict') c.sameSite(SameSite.Strict);
                else if (lv == 'lax') c.sameSite(SameSite.Lax);
                else if (lv == 'none') c.sameSite(SameSite.None);
            } else if (an == 'secure') c.secure(true);
            else if (an == 'httponly') c.httpOnly(true);
            else if (an == 'partitioned') c.partitioned(true);
            else if (an == 'priority') c.priority(avv);
            else c.extension(av); // unknown extension attribute, kept verbatim
        }
        return c;
    }

    /** Percent-encode a value as the default `Cookie` encoding would. */
    static encodeValue(raw: string): string {
        return percentEncode(raw);
    }

    /** Percent-decode a value (the inverse of {@link encodeValue}). */
    static decodeValue(enc: string): string {
        return percentDecode(enc);
    }
}

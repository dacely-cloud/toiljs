/**
 * The incoming HTTP request handed to the user's handler. Decoded
 * from the wire envelope the host wrote at offset 0 of linear
 * memory. See `envelope.ts`.
 */

import { Cookies, CookieMap } from './http/cookies';

export enum Method {
    GET = 0,
    POST = 1,
    PUT = 2,
    DELETE = 3,
    PATCH = 4,
    HEAD = 5,
    OPTIONS = 6,
    UNKNOWN = 255,
}

export class Header {
    name: string;
    value: string;

    constructor(name: string, value: string) {
        this.name = name;
        this.value = value;
    }
}

export class Request {
    method: Method;
    path: string;
    headers: Array<Header>;
    body: Uint8Array;

    // Lazily parsed `Cookie` header, cached for the life of the request.
    private _cookies: CookieMap | null = null;

    constructor(method: Method, path: string, headers: Array<Header>, body: Uint8Array) {
        this.method = method;
        this.path = path;
        this.headers = headers;
        this.body = body;
    }

    /**
     * Case-insensitive header lookup. Returns `null` if not present.
     * O(n) over the header list; the request typically carries fewer
     * than a dozen, so the linear scan is the right call.
     */
    header(name: string): string | null {
        const lower = name.toLowerCase();
        for (let i = 0; i < this.headers.length; i++) {
            if (this.headers[i].name.toLowerCase() == lower) {
                return this.headers[i].value;
            }
        }
        return null;
    }

    /**
     * The request's cookies, parsed from the `Cookie` header (values are
     * percent-decoded). Parsed once and cached; an empty map if there is no
     * `Cookie` header.
     */
    cookies(): CookieMap {
        const cached = this._cookies;
        if (cached != null) return cached;
        const h = this.header('cookie');
        const map = h == null ? new CookieMap() : Cookies.parse(h);
        this._cookies = map;
        return map;
    }

    /** A single cookie value by name, or `null` if absent. */
    cookie(name: string): string | null {
        return this.cookies().get(name);
    }
}

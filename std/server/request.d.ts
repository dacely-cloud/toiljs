// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * The incoming HTTP request handed to the user's handler. Decoded
 * from the wire envelope the host wrote at offset 0 of linear
 * memory. See `envelope.ts`.
 */
import { CookieMap } from './http/cookies';
export declare enum Method {
    GET = 0,
    POST = 1,
    PUT = 2,
    DELETE = 3,
    PATCH = 4,
    HEAD = 5,
    OPTIONS = 6,
    UNKNOWN = 255
}
export declare class Header {
    name: string;
    value: string;
    constructor(name: string, value: string);
}
export declare class Request {
    method: Method;
    path: string;
    headers: Array<Header>;
    body: Uint8Array;
    __authChecked: bool;
    __authBytes: Uint8Array | null;
    __authExpires: u64;
    private _cookies;
    constructor(method: Method, path: string, headers: Array<Header>, body: Uint8Array);
    /**
     * Case-insensitive header lookup. Returns `null` if not present.
     * O(n) over the header list; the request typically carries fewer
     * than a dozen, so the linear scan is the right call.
     */
    header(name: string): string | null;
    /**
     * The request's cookies, parsed from the `Cookie` header (values are
     * percent-decoded). Parsed once and cached; an empty map if there is no
     * `Cookie` header.
     */
    cookies(): CookieMap;
    /** A single cookie value by name, or `null` if absent. */
    cookie(name: string): string | null;
}

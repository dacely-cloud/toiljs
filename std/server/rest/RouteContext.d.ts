// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * Per-request context handed to a `@route` method. Carries the captured path
 * params (`/todos/:id`), the parsed query string, and the raw `Request`. The
 * compiler builds one of these for you and injects it into any route method
 * that declares a `RouteContext` parameter.
 */
import { Request } from '../request';
export declare class RouteContext {
    /** The raw incoming request (method, path, headers, body). */
    request: Request;
    private paramKeys;
    private paramVals;
    private queryKeys;
    private queryVals;
    constructor(request: Request, paramKeys: Array<string>, paramVals: Array<string>);
    /** A captured path parameter (`/todos/:id` gives `param("id")`), or "" if absent. */
    param(name: string): string;
    /** A decoded query value, or "" if absent. Percent escapes and form `+` are decoded once. */
    query(name: string): string;
    /** Case-insensitive request header, or null. Delegates to `Request.header`. */
    header(name: string): string | null;
    /** The raw request body decoded as UTF-8 text (used by the JSON stream codec). */
    text(): string;
    /**
     * The connecting client's IP as a string ("203.0.113.7" or an IPv6 form),
     * or "" if unavailable. This is the TRUSTED socket peer the edge observed,
     * not a forgeable header like X-Forwarded-For, so it is safe to key rate
     * limits, geo, or audit logs on it.
     */
    clientIp(): string;
    private ensureQuery;
}

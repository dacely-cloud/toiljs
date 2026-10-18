// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * The response the user's handler builds. Serialised into a wire
 * envelope at a fixed offset before `handle()` returns. See
 * `envelope.ts` and `dispatch.ts`.
 */
import { Header } from './request';
import { Cookie } from './http/cookie';
/**
 * Marker header on the runtime's fallback 404 (no route matched, no handler
 * wired). The host can use it to fall through to another layer, the dev
 * server hands such requests to Vite (client routes, assets), and strips the
 * marker before anything reaches the browser. A deliberate
 * `Response.notFound()` does not carry it. Mirrored as `UNHANDLED_HEADER` in
 * `src/devserver/module.ts`.
 */
export declare const TOIL_UNHANDLED_HEADER: string;
export declare class Response {
    status: u16;
    headers: Array<Header>;
    body: Uint8Array;
    constructor(status: u16, body: Uint8Array, headers?: Array<Header> | null);
    static text(body: string, status?: u16): Response;
    static html(body: string, status?: u16): Response;
    static json(body: string, status?: u16): Response;
    /** A JSON @data value with an explicit HTTP status. */
    static data<T>(value: T, status?: u16): Response;
    /**
     * A raw binary body, defaulting to `application/octet-stream`. Used by `@route`
     * methods with `stream: DataStream.Binary` to ship a `@data` `encode()`.
     */
    static bytes(body: Uint8Array, status?: u16, contentType?: string): Response;
    static notFound(): Response;
    /**
     * The "this server has no answer for that path" 404: a `notFound()`
     * carrying {@link TOIL_UNHANDLED_HEADER} so the host may serve the path
     * itself (static files, the client app). Returned by the framework when
     * dispatch misses; handlers that mean "looked it up, does not exist"
     * should return `notFound()` instead.
     */
    static unhandled(): Response;
    static badRequest(msg?: string): Response;
    static internalError(msg?: string): Response;
    static empty(status: u16): Response;
    /**
     * Replace all headers with this name (case-insensitive). Returns `this`.
     */
    setHeader(name: string, value: string): Response;
    /**
     * Append a `Set-Cookie` for `cookie`. Each call adds its own header entry,
     * so multiple cookies are emitted as separate `Set-Cookie` headers (never
     * folded). Builder-style: returns `this`.
     */
    setCookie(cookie: Cookie): Response;
    /** Shorthand for `setCookie(new Cookie(name, value))` (no attributes). */
    setCookieKV(name: string, value: string): Response;
    /**
     * Append a `Set-Cookie` that deletes `name`: empty value, `Max-Age=0`, and
     * an epoch `Expires`. `path` (default `/`) and `domain` must match the
     * cookie being cleared for the browser to drop it. Builder-style.
     */
    clearCookie(name: string, path?: string, domain?: string): Response;
    /**
     * Mark this response cacheable at the toil edge and/or the browser.
     *
     * `edgeTtlMinutes` caches the response on the edge node (per-core,
     * keyed by host + method + path + request body) for up to that many
     * minutes -- the ONLY way a POST response is cached. `browserTtlSeconds`
     * emits a `Cache-Control: max-age` for the client.
     *
     * Host-side safety, enforced no matter what you ask for: the edge TTL
     * is clamped to 24h, only 2xx responses are edge-cached, a response
     * carrying a `Set-Cookie` is never edge-cached, and an AUTHENTICATED
     * request (one with a `Cookie` or `Authorization` header) is not
     * edge-cached unless you pass `allowAuth = true`. Only mark a response
     * cacheable when its body is a pure function of (host, path, body) --
     * never per-user data keyed by a cookie/header that is not in the path
     * or body, or one user's response could be served to another.
     *
     * Builder-style: returns `this`.
     */
    cache(edgeTtlMinutes: u16, browserTtlSeconds?: u32, privateScope?: bool, allowAuth?: bool): Response;
    /**
     * Shorthand for {@link cache}: edge-cache this response for `minutes`
     * minutes (no browser caching).
     */
    cacheFor(minutes: u16): Response;
}
/** Fill browser security headers at the HTTP serialization boundary. */
export declare function ensureSecurityHeaders(response: Response): void;

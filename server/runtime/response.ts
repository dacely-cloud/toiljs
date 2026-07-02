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
export const TOIL_UNHANDLED_HEADER: string = 'x-toil-unhandled';

export class Response {
    status: u16;
    headers: Array<Header>;
    body: Uint8Array;

    constructor(status: u16, body: Uint8Array, headers: Array<Header> | null = null) {
        this.status = status;
        this.body = body;
        this.headers = headers != null ? headers : new Array<Header>();
    }

    public static text(body: string, status: u16 = 200): Response {
        const buf = String.UTF8.encode(body);
        const bytes = Uint8Array.wrap(buf);
        const r = new Response(status, bytes);

        r.setHeader('content-type', 'text/plain; charset=utf-8');

        return r;
    }

    public static html(body: string, status: u16 = 200): Response {
        const buf = String.UTF8.encode(body);
        const bytes = Uint8Array.wrap(buf);
        const r = new Response(status, bytes);

        r.setHeader('content-type', 'text/html; charset=utf-8');

        return r;
    }

    public static json(body: string, status: u16 = 200): Response {
        const buf = String.UTF8.encode(body);
        const bytes = Uint8Array.wrap(buf);
        const r = new Response(status, bytes);

        r.setHeader('content-type', 'application/json; charset=utf-8');

        return r;
    }

    /**
     * A raw binary body, tagged `application/octet-stream`. Used by `@route`
     * methods with `stream: DataStream.Binary` to ship a `@data` `encode()`.
     */
    public static bytes(body: Uint8Array, status: u16 = 200): Response {
        const r = new Response(status, body);

        r.setHeader('content-type', 'application/octet-stream');

        return r;
    }

    public static notFound(): Response {
        return Response.text('not found\n', 404);
    }

    /**
     * The "this server has no answer for that path" 404: a `notFound()`
     * carrying {@link TOIL_UNHANDLED_HEADER} so the host may serve the path
     * itself (static files, the client app). Returned by the framework when
     * dispatch misses; handlers that mean "looked it up, does not exist"
     * should return `notFound()` instead.
     */
    public static unhandled(): Response {
        const r = Response.notFound();
        r.setHeader(TOIL_UNHANDLED_HEADER, '1');
        return r;
    }

    public static badRequest(msg: string = 'bad request'): Response {
        return Response.text(msg + '\n', 400);
    }

    public static internalError(msg: string = 'internal error'): Response {
        return Response.text(msg + '\n', 500);
    }

    public static empty(status: u16): Response {
        return new Response(status, new Uint8Array(0));
    }

    /**
     * Builder-style: returns `this` so calls can chain.
     */
    public setHeader(name: string, value: string): Response {
        this.headers.push(new Header(name, value));

        return this;
    }

    /**
     * Append a `Set-Cookie` for `cookie`. Each call adds its own header entry,
     * so multiple cookies are emitted as separate `Set-Cookie` headers (never
     * folded). Builder-style: returns `this`.
     */
    public setCookie(cookie: Cookie): Response {
        this.headers.push(new Header('set-cookie', cookie.serialize()));

        return this;
    }

    /** Shorthand for `setCookie(new Cookie(name, value))` (no attributes). */
    public setCookieKV(name: string, value: string): Response {
        return this.setCookie(new Cookie(name, value));
    }

    /**
     * Append a `Set-Cookie` that deletes `name`: empty value, `Max-Age=0`, and
     * an epoch `Expires`. `path` (default `/`) and `domain` must match the
     * cookie being cleared for the browser to drop it. Builder-style.
     */
    public clearCookie(name: string, path: string = '/', domain: string = ''): Response {
        const c = new Cookie(name, '').path(path).maxAge(0).expires(0);
        if (domain.length > 0) c.domain(domain);

        return this.setCookie(c);
    }

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
    public cache(
        edgeTtlMinutes: u16,
        browserTtlSeconds: u32 = 0,
        privateScope: bool = false,
        allowAuth: bool = false,
    ): Response {
        let v = '';
        if (edgeTtlMinutes > 0) {
            v = 'edge=' + edgeTtlMinutes.toString();
        }
        if (browserTtlSeconds > 0) {
            if (v.length > 0) v += '; ';
            v += 'browser=' + browserTtlSeconds.toString();
        }
        if (privateScope) {
            if (v.length > 0) v += '; ';
            v += 'scope=private';
        }
        if (allowAuth) {
            if (v.length > 0) v += '; ';
            v += 'auth=1';
        }
        if (v.length > 0) {
            this.setHeader('dacely-cache-control', v);
        }

        return this;
    }

    /**
     * Shorthand for {@link cache}: edge-cache this response for `minutes`
     * minutes (no browser caching).
     */
    public cacheFor(minutes: u16): Response {
        return this.cache(minutes);
    }
}

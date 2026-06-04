/**
 * The response the user's handler builds. Serialised into a wire
 * envelope at a fixed offset before `handle()` returns. See
 * `envelope.ts` and `dispatch.ts`.
 */

import { Header } from './request';

export class Response {
    status: u16;
    headers: Array<Header>;
    body: Uint8Array;

    constructor(status: u16, body: Uint8Array, headers: Array<Header> | null = null) {
        this.status = status;
        this.body = body;
        this.headers = headers != null ? headers : new Array<Header>();
    }

    /**
     * Builder-style: returns `this` so calls can chain.
     */
    setHeader(name: string, value: string): Response {
        this.headers.push(new Header(name, value));
        return this;
    }

    // ---- factories ----

    static text(body: string, status: u16 = 200): Response {
        const buf = String.UTF8.encode(body);
        const bytes = Uint8Array.wrap(buf);
        const r = new Response(status, bytes);
        r.setHeader('content-type', 'text/plain; charset=utf-8');
        return r;
    }

    static html(body: string, status: u16 = 200): Response {
        const buf = String.UTF8.encode(body);
        const bytes = Uint8Array.wrap(buf);
        const r = new Response(status, bytes);
        r.setHeader('content-type', 'text/html; charset=utf-8');
        return r;
    }

    static json(body: string, status: u16 = 200): Response {
        const buf = String.UTF8.encode(body);
        const bytes = Uint8Array.wrap(buf);
        const r = new Response(status, bytes);
        r.setHeader('content-type', 'application/json; charset=utf-8');
        return r;
    }

    static notFound(): Response {
        return Response.text('not found\n', 404);
    }

    static badRequest(msg: string = 'bad request'): Response {
        return Response.text(msg + '\n', 400);
    }

    static internalError(msg: string = 'internal error'): Response {
        return Response.text(msg + '\n', 500);
    }

    static empty(status: u16): Response {
        return new Response(status, new Uint8Array(0));
    }
}

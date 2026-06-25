/**
 * Transparent proxy from the uWebSockets.js front server to the internal Vite
 * dev server, so every Vite dev feature (module transforms, HMR websocket,
 * `/__toil/*` toolbar endpoints, public assets, SPA fallback) keeps working
 * unchanged behind the WASM dispatcher. HTTP goes through `fetch`, the HMR
 * websocket through Node's built-in `WebSocket` client, both loopback-only.
 */

import { type Request, type Response, type Server, type Websocket } from '@dacely/hyper-express';

/** Where the internal Vite dev server listens (always loopback). */
export interface ViteTarget {
    readonly host: string;
    readonly port: number;
}

/**
 * Hop-by-hop request headers (RFC 9110 §7.6.1) plus headers `fetch` manages
 * itself; everything else is forwarded verbatim. `accept-encoding` is dropped
 * so Vite answers identity-encoded and bytes can be piped through untouched.
 */
const SKIP_REQUEST_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-length',
    'accept-encoding',
]);

/** Response headers owned by the front server's own HTTP framing. */
const SKIP_RESPONSE_HEADERS = new Set([
    'connection',
    'keep-alive',
    'content-length',
    'content-encoding',
    'transfer-encoding',
]);

/** Forwards one HTTP request to Vite and streams the answer back. */
export async function proxyToVite(
    request: Request,
    response: Response,
    target: ViteTarget,
): Promise<void> {
    const url = `http://${target.host}:${String(target.port)}${request.url}`;

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (!SKIP_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? await request.buffer() : undefined;

    const upstream = await fetch(url, {
        method: request.method,
        headers,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
        // The browser follows redirects itself; pass them through untouched.
        redirect: 'manual',
    });

    response.status(upstream.status);
    upstream.headers.forEach((value, name) => {
        if (!SKIP_RESPONSE_HEADERS.has(name)) response.header(name, value);
    });

    // Buffer the full upstream body and send it with a content-length, instead
    // of streaming it. uWS/hyper-express chunked-streaming of a `fetch` body
    // emitted an INVALID chunked encoding in the browser
    // (net::ERR_INVALID_CHUNKED_ENCODING), so client modules failed to load. Dev
    // responses are finite (HMR rides the separate websocket), so buffering is
    // safe and sidesteps the chunked framing entirely.
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length === 0) {
        response.send();
        return;
    }
    response.send(buf);
}

/**
 * A uWS message as something `WebSocket.send` accepts: text stays a string,
 * binary is copied into a plain `ArrayBuffer`-backed view (a `Buffer` may sit
 * on a shared pool slab, which the WebSocket types reject).
 */
function toUpstreamMessage(data: Buffer, binary: boolean): string | Uint8Array<ArrayBuffer> {
    if (!binary) return data.toString('utf8');
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return copy;
}

/**
 * Wires a catch-all websocket route that pipes every upgrade (Vite's HMR
 * socket connects to the page origin at `/`, subprotocol `vite-hmr`) to the
 * internal Vite server. Messages are queued until the upstream socket opens,
 * closes propagate in both directions.
 */
export function wireWebsocketProxy(app: Server, target: ViteTarget): void {
    app.upgrade('/*', (request: Request, response: Response) => {
        response.upgrade({
            url: request.url,
            protocol: request.headers['sec-websocket-protocol'] ?? '',
        });
    });

    app.ws(
        '/*',
        { message_type: 'Buffer', idle_timeout: 120, max_payload_length: 16 * 1024 * 1024 },
        (ws: Websocket) => {
            pipeToVite(ws, target, ws.context as { url: string; protocol: string });
        },
    );
}

/**
 * Pipe ONE upgraded websocket to the internal Vite HMR server. The verbatim body extracted from
 * {@link wireWebsocketProxy} so the dev STREAM router (doc 08 4.1 `wireStreams`) can reuse it for every
 * NON-stream upgrade while it handles `@stream`-route upgrades itself - HMR stays byte-for-byte
 * unchanged. `ctx` is the upgrade context (`{ url, protocol }`) the upgrade handler stamped.
 */
export function pipeToVite(
    ws: Websocket,
    target: ViteTarget,
    ctx: { url: string; protocol: string },
): void {
    const { url, protocol } = ctx;
    const upstream = new WebSocket(
        `ws://${target.host}:${String(target.port)}${url}`,
        protocol ? protocol.split(',').map((p) => p.trim()) : [],
    );
    upstream.binaryType = 'arraybuffer';

    const pending: (string | Uint8Array<ArrayBuffer>)[] = [];
    let open = false;

    upstream.onopen = (): void => {
        open = true;
        for (const m of pending) upstream.send(m);
        pending.length = 0;
    };
    upstream.onmessage = (event: MessageEvent): void => {
        if (typeof event.data === 'string') ws.send(event.data);
        else ws.send(Buffer.from(event.data as ArrayBuffer), true);
    };
    upstream.onclose = (event: CloseEvent): void => {
        ws.close(event.code, event.reason);
    };
    upstream.onerror = (): void => {
        ws.close();
    };

    ws.on('message', (message: Buffer, isBinary: boolean) => {
        const m = toUpstreamMessage(message, isBinary);
        if (open) upstream.send(m);
        else pending.push(m);
    });
    ws.on('close', () => {
        if (
            upstream.readyState === WebSocket.OPEN ||
            upstream.readyState === WebSocket.CONNECTING
        ) {
            upstream.close();
        }
    });
}

/**
 * Client runtime for the typed `@stream` channel (doc 08 section 8.2). `Server.Stream.<Class>.connect(path?)`
 * opens a browser `WebTransport` session to the class's `route` on the production edge (an `https://`
 * stream-tier origin), or a `WebSocket` against the dev server (a `ws(s)://` origin), and returns a channel:
 * `onMessage` / `send` / `onClose` / `close`. A raw `@stream` channel sends `Uint8Array`; a typed
 * `@stream({ message: T })` channel sends the `@data` class and encodes it on send (the per-class
 * encoder the generated module passes). The inbound reply is always raw bytes. The generated
 * `shared/server.ts` (toilscript hot pass) attaches `makeStreamClient(routes, undefined, encoders)` to
 * `globalThis.__toilStream`, and `Server.Stream`
 * (`rpc.ts`) surfaces it - the same wiring the REST client uses via `globalThis.__toilRest`.
 */

/** A live `@stream` connection. `TSend` is the outbound message type: `Uint8Array` for a raw `@stream`,
 *  or the `@data` class for a typed `@stream({ message: T })` (the channel encodes it before sending).
 *  The inbound reply is ALWAYS raw bytes - the server's `StreamOutbound` is raw (doc 03 2.5). */
export interface StreamChannel<TSend = Uint8Array> {
    /** Register the inbound-frame handler (one call per server reply frame). */
    onMessage(cb: (data: Uint8Array) => void): void;
    /** Send one outbound message (one `@message` on the server); a typed channel encodes it first. */
    send(data: TSend): void;
    /** Register the close handler (`code` is the `0x02xx` stream close code, or the WS code). */
    onClose(cb: (code: number) => void): void;
    /** Close the connection. */
    close(): void;
}

/** The connect factory for one `@stream` class. `path` is the `@connect` path (default `''`). */
export interface StreamConnectable<TSend = Uint8Array> {
    connect(path?: string): Promise<StreamChannel<TSend>>;
}

/** `Server.Stream`: one `connect()` factory per `@stream` class name. */
export type StreamClient = Record<string, StreamConnectable>;

/** Open a WebSocket to `url` and resolve a channel once the upgrade completes; reject if the socket
 *  closes/errors BEFORE it opens (a 421 redirect / wrong-node / unreachable). A server close AFTER
 *  open (e.g. a `@connect` reject or a guest reject) surfaces through `onClose(code)`. */
function connectStream<TSend = Uint8Array>(
    url: string,
    encode?: (msg: never) => Uint8Array,
): Promise<StreamChannel<TSend>> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        let opened = false;
        let messageCb: ((data: Uint8Array) => void) | undefined;
        let closeCb: ((code: number) => void) | undefined;

        const channel: StreamChannel<TSend> = {
            onMessage: (cb): void => {
                messageCb = cb;
            },
            onClose: (cb): void => {
                closeCb = cb;
            },
            send: (data): void => {
                if (ws.readyState !== WebSocket.OPEN) return;
                // A typed channel encodes the @data message; a raw channel sends the bytes as-is.
                const bytes = encode ? encode(data as never) : (data as unknown as Uint8Array);
                ws.send(bytes as BufferSource);
            },
            close: (): void => {
                ws.close();
            },
        };

        ws.addEventListener('open', () => {
            opened = true;
            resolve(channel);
        });
        ws.addEventListener('message', (event: MessageEvent) => {
            if (event.data instanceof ArrayBuffer) messageCb?.(new Uint8Array(event.data));
        });
        ws.addEventListener('close', (event: CloseEvent) => {
            if (!opened) reject(new Error(`stream connect failed (closed ${String(event.code)})`));
            else closeCb?.(event.code);
        });
        ws.addEventListener('error', () => {
            if (!opened) reject(new Error('stream connect error'));
        });
    });
}

/** Open a browser `WebTransport` session to `url` (an `https://` stream-tier origin) and resolve a
 *  channel once the session is ready. The browser drives the QUIC handshake, H3 Extended-CONNECT, and
 *  the RFC 9297 Quarter-Stream-ID datagram framing, so `send`/`onMessage` deal in raw bytes (no manual
 *  prefix). Rejects if the session fails to open (wrong node / unreachable / cert); a server close AFTER
 *  open surfaces via `onClose(code)`. This is the PRODUCTION transport - the L2/L3 edge is
 *  WebTransport-only; the dev server uses the `connectStream` WebSocket above. */
function connectStreamWT<TSend = Uint8Array>(
    url: string,
    encode?: (msg: never) => Uint8Array,
): Promise<StreamChannel<TSend>> {
    return new Promise((resolve, reject) => {
        if (!('WebTransport' in globalThis)) {
            reject(new Error('WebTransport is not available in this browser'));
            return;
        }
        let transport: WebTransport;
        try {
            transport = new WebTransport(url);
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
        }
        let messageCb: ((data: Uint8Array) => void) | undefined;
        let closeCb: ((code: number) => void) | undefined;
        let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
        let opened = false;
        const pending: Uint8Array[] = [];

        const channel: StreamChannel<TSend> = {
            onMessage: (cb): void => {
                messageCb = cb;
                for (const m of pending) cb(m);
                pending.length = 0;
            },
            onClose: (cb): void => {
                closeCb = cb;
            },
            send: (data): void => {
                if (!writer) return;
                const bytes = encode ? encode(data as never) : (data as unknown as Uint8Array);
                void writer.write(bytes);
            },
            close: (): void => {
                try {
                    transport.close();
                } catch {
                    /* already closing */
                }
            },
        };

        // A close AFTER open (guest reject, idle sweep, server shutdown) reports through onClose; a
        // failure BEFORE open rejects the connect() promise via the `ready` catch below.
        transport.closed
            .then((info) => {
                if (opened) closeCb?.(info?.closeCode ?? 0);
            })
            .catch(() => {
                if (opened) closeCb?.(1);
            });

        transport.ready
            .then(() => {
                opened = true;
                writer = transport.datagrams.writable.getWriter();
                const reader = transport.datagrams.readable.getReader();
                void (async (): Promise<void> => {
                    try {
                        for (;;) {
                            const { value, done } = await reader.read();
                            if (done) break;
                            const bytes =
                                value instanceof Uint8Array
                                    ? value
                                    : new Uint8Array(value as ArrayBufferLike);
                            if (messageCb) messageCb(bytes);
                            else pending.push(bytes);
                        }
                    } catch {
                        /* read loop ended on session close */
                    }
                })();
                resolve(channel);
            })
            .catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
    });
}

/** Pick the transport by origin scheme: `https://` -> WebTransport (the production L2/L3 edge),
 *  `ws(s)://` -> WebSocket (the dev server). The generated `shared/server.ts` sets the scheme per build
 *  (edge: `https://wt.<tenant>`; dev: same-origin `wss://`). */
function openChannel<TSend = Uint8Array>(
    url: string,
    encode?: (msg: never) => Uint8Array,
): Promise<StreamChannel<TSend>> {
    return url.startsWith('https://')
        ? connectStreamWT<TSend>(url, encode)
        : connectStream<TSend>(url, encode);
}

/** The same-origin WebSocket base (`ws://` / `wss://` per the page protocol). */
function defaultOrigin(): string {
    const loc = globalThis.location;
    return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}`;
}

/** Resolve the stream-tier origin when the generated client passes none. A deploy/runtime override -
 *  `globalThis.__TOIL_STREAM_ORIGIN__` (e.g. `"https://wt.dacely.com"`, the production L2/L3 edge) -
 *  wins; otherwise fall back to the same-origin WebSocket base (the dev server). The edge override is
 *  `https://` so `openChannel` selects WebTransport; the dev fallback is `ws(s)://` so it selects
 *  WebSocket. This is how a deployed app points at its `wt.<tenant>` tier without the build knowing it. */
function resolveStreamOrigin(): string {
    const override = (globalThis as { __TOIL_STREAM_ORIGIN__?: unknown }).__TOIL_STREAM_ORIGIN__;
    if (typeof override === 'string' && override.length > 0) return override;
    return defaultOrigin();
}

/**
 * Build the `Server.Stream` client from the generated route map (`{ ClassName: route }`). `origin`
 * defaults to the page origin. `encoders` carries one `@data` encoder per typed `@stream({ message: T })`
 * class (the generated `(m) => m.encode()`); a class with no entry is a raw byte channel. The generated
 * `shared/server.ts` calls this and assigns the result to `globalThis.__toilStream`.
 */
export function makeStreamClient(
    routes: Record<string, string>,
    origin?: string,
    encoders?: Record<string, (msg: never) => Uint8Array>,
): StreamClient {
    const client: StreamClient = {};
    for (const [name, route] of Object.entries(routes)) {
        const encode = encoders?.[name];
        client[name] = {
            // Resolve the origin LAZILY, per connect() - so a deploy/app that sets
            // `__TOIL_STREAM_ORIGIN__` after this module loads is still honoured.
            connect: (path = ''): Promise<StreamChannel> =>
                openChannel(`${origin ?? resolveStreamOrigin()}${route}${path}`, encode),
        };
    }
    return client;
}

/**
 * Client runtime for the typed `@stream` channel (doc 08 section 8.2). `Server.Stream.<Class>.connect(path?)`
 * opens a browser `WebSocket` to the class's `route` (same origin) and returns a channel:
 * `onMessage` / `send` / `onClose` / `close`. RAW byte mode (the default `@message` bridge); the typed
 * `@data` codec (`messageMode = 'data'`) is a follow-up. The generated `shared/server.ts` (toilscript
 * hot pass) attaches `makeStreamClient(routes)` to `globalThis.__toilStream`, and `Server.Stream`
 * (`rpc.ts`) surfaces it - the same wiring the REST client uses via `globalThis.__toilRest`.
 */

/** A live `@stream` connection. RAW frames are `Uint8Array`; the typed-message codec is a follow-up. */
export interface StreamChannel {
    /** Register the inbound-frame handler (one call per server reply frame). */
    onMessage(cb: (data: Uint8Array) => void): void;
    /** Send one outbound frame (one `@message` on the server). */
    send(data: Uint8Array): void;
    /** Register the close handler (`code` is the `0x02xx` stream close code, or the WS code). */
    onClose(cb: (code: number) => void): void;
    /** Close the connection. */
    close(): void;
}

/** The connect factory for one `@stream` class. `path` is the `@connect` path (default `''`). */
export interface StreamConnectable {
    connect(path?: string): Promise<StreamChannel>;
}

/** `Server.Stream`: one `connect()` factory per `@stream` class name. */
export type StreamClient = Record<string, StreamConnectable>;

/** Open a WebSocket to `url` and resolve a channel once the upgrade completes; reject if the socket
 *  closes/errors BEFORE it opens (a 421 redirect / wrong-node / unreachable). A server close AFTER
 *  open (e.g. a `@connect` reject or a guest reject) surfaces through `onClose(code)`. */
function connectStream(url: string): Promise<StreamChannel> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        let opened = false;
        let messageCb: ((data: Uint8Array) => void) | undefined;
        let closeCb: ((code: number) => void) | undefined;

        const channel: StreamChannel = {
            onMessage: (cb): void => {
                messageCb = cb;
            },
            onClose: (cb): void => {
                closeCb = cb;
            },
            send: (data): void => {
                if (ws.readyState === WebSocket.OPEN) ws.send(data as BufferSource);
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

/** The same-origin WebSocket base (`ws://` / `wss://` per the page protocol). */
function defaultOrigin(): string {
    const loc = globalThis.location;
    return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}`;
}

/**
 * Build the `Server.Stream` client from the generated route map (`{ ClassName: route }`). `origin`
 * defaults to the page origin; the generated `shared/server.ts` calls this and assigns the result to
 * `globalThis.__toilStream`.
 */
export function makeStreamClient(routes: Record<string, string>, origin?: string): StreamClient {
    const base = origin ?? defaultOrigin();
    const client: StreamClient = {};
    for (const [name, route] of Object.entries(routes)) {
        client[name] = { connect: (path = ''): Promise<StreamChannel> => connectStream(`${base}${route}${path}`) };
    }
    return client;
}

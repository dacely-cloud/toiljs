/**
 * Client runtime for the typed `@stream` channel (doc 08 section 8.2). `Server.Stream.<Class>.connect(path?)`
 * opens a browser `WebSocket` to the class's `route` (same origin) and returns a channel:
 * `onMessage` / `send` / `onClose` / `close`. RAW byte mode (the default `@message` bridge); the typed
 * `@data` codec (`messageMode = 'data'`) is a follow-up. The generated `shared/server.ts` (toilscript
 * hot pass) attaches `makeStreamClient(routes)` to `globalThis.__toilStream`, and `Server.Stream`
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

/** The same-origin WebSocket base (`ws://` / `wss://` per the page protocol). */
function defaultOrigin(): string {
    const loc = globalThis.location;
    return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}`;
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
    const base = origin ?? defaultOrigin();
    const client: StreamClient = {};
    for (const [name, route] of Object.entries(routes)) {
        const encode = encoders?.[name];
        client[name] = {
            connect: (path = ''): Promise<StreamChannel> => connectStream(`${base}${route}${path}`, encode),
        };
    }
    return client;
}

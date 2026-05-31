/**
 * toiljs backend — the self-host / dev server, built on @btc-vision/hyper-express (uWebSockets.js)
 * for very high throughput. It serves the built client (static assets + SPA fallback) and exposes
 * a WebSocket channel for realtime / live updates.
 *
 * This is the Node "server" that hosts the app on a local machine; it is distinct from the
 * toilscript WASM target in `src/server`.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
    Server,
    type MiddlewareNext,
    type Request,
    type Response,
    type Websocket,
} from '@btc-vision/hyper-express';

const DEFAULT_MAX_BODY_LENGTH = 1024 * 1024 * 8;
const MAX_BODY_BUFFER = 1024 * 32;
const HTTP_IDLE_TIMEOUT = 60;
const HTTP_RESPONSE_TIMEOUT = 120;

const WS_MAX_PAYLOAD_LENGTH = 1024 * 1024;
const WS_IDLE_TIMEOUT = 120;
const WS_MAX_BACKPRESSURE = 1024 * 1024 * 2;

const CORS_METHODS = 'GET, POST, OPTIONS, PUT, PATCH, DELETE';
const CORS_HEADERS = 'X-Requested-With, content-type';

/** Options for {@link startBackend}. */
export interface BackendOptions {
    /** Directory to serve (the built client `outDir`, e.g. `dist`). */
    readonly root: string;
    /** Listening port. Default `3000`. */
    readonly port?: number;
    /** Bind host. Default `0.0.0.0`. */
    readonly host?: string;
    /** WebSocket channel path. Default `/_toil`. */
    readonly wsPath?: string;
    /** Send permissive CORS headers + handle preflight. Default `true`. */
    readonly cors?: boolean;
    /** Max request body length in bytes. Default 8 MB. */
    readonly maxBodyLength?: number;
}

/** A running backend instance. */
export interface RunningBackend {
    readonly port: number;
    readonly host: string;
    readonly wsPath: string;
    /** Sends a message to every connected WebSocket client. */
    broadcast(message: string): void;
    /** Number of currently-connected WebSocket clients. */
    clientCount(): number;
    /** Gracefully shuts the server down. */
    close(): Promise<void>;
}

/** Resolves a request path to a file inside `root`, guarding against path traversal. */
function resolveStaticFile(root: string, requestPath: string): string | null {
    const decoded = decodeURIComponent(requestPath);
    const resolved = path.join(root, decoded);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    if (decoded === '/' || decoded === '') return null;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    return null;
}

/**
 * Starts the hyper-express server serving `root` with an SPA fallback to `index.html`,
 * plus a WebSocket channel at `wsPath`. Resolves once the server is listening.
 */
export async function startBackend(options: BackendOptions): Promise<RunningBackend> {
    const port = options.port ?? 3000;
    const host = options.host ?? '0.0.0.0';
    const wsPath = options.wsPath ?? '/_toil';
    const cors = options.cors ?? true;
    const root = path.resolve(options.root);
    const indexHtml = path.join(root, 'index.html');

    const app = new Server({
        max_body_length: options.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH,
        max_body_buffer: MAX_BODY_BUFFER,
        fast_abort: true,
        idle_timeout: HTTP_IDLE_TIMEOUT,
        response_timeout: HTTP_RESPONSE_TIMEOUT,
    });

    const clients = new Set<Websocket>();

    app.set_error_handler((_request: Request, response: Response, _error: Error) => {
        if (response.completed) return;
        response.atomic(() => {
            response.status(500).json({ error: 'Internal server error.' });
        });
    });

    if (cors) {
        app.use((request: Request, response: Response, next: MiddlewareNext) => {
            if (request.method !== 'OPTIONS') {
                response.setHeader('Access-Control-Allow-Origin', '*');
                response.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
                response.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
            }
            response.removeHeader('uWebSockets');
            next();
        });
        app.options('/*', (_request: Request, response: Response) => {
            response.setHeader('Access-Control-Allow-Origin', '*');
            response.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
            response.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
            response.setHeader('Access-Control-Max-Age', '86400');
            response.status(204).send();
        });
    }

    app.ws(
        wsPath,
        {
            message_type: 'String',
            max_payload_length: WS_MAX_PAYLOAD_LENGTH,
            idle_timeout: WS_IDLE_TIMEOUT,
            max_backpressure: WS_MAX_BACKPRESSURE,
        },
        (ws) => {
            clients.add(ws);
            ws.send(JSON.stringify({ type: 'connected', clients: clients.size }));
            ws.on('message', (message: string) => {
                for (const client of clients) client.send(message);
            });
            ws.on('drain', () => {});
            ws.on('close', () => {
                clients.delete(ws);
            });
        },
    );

    app.get('/*', (request: Request, response: Response) => {
        if (response.completed) return;
        const file = resolveStaticFile(root, request.path);
        response.sendFile(file ?? indexHtml);
    });

    await app.listen(port, host);

    return {
        port,
        host,
        wsPath,
        broadcast: (message: string): void => {
            for (const client of clients) client.send(message);
        },
        clientCount: (): number => clients.size,
        close: async (): Promise<void> => {
            await app.shutdown();
        },
    };
}

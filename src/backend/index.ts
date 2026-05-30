/**
 * toiljs backend — the self-host / dev server, built on @btc-vision/hyper-express (uWebSockets.js)
 * for very high throughput. It serves the built client (static assets + SPA fallback) and exposes
 * a WebSocket channel for realtime / live updates.
 *
 * This is the Node "server" that hosts the app on a local machine; it is distinct from the
 * AssemblyScript WASM target in `src/server`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Server, type Websocket } from '@btc-vision/hyper-express';

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
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null; // traversal
    if (decoded === '/' || decoded === '') return null; // defer to SPA fallback
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
    const root = path.resolve(options.root);
    const indexHtml = path.join(root, 'index.html');

    const app = new Server();
    const clients = new Set<Websocket>();

    // Realtime WebSocket channel: each client joins, messages are broadcast to all peers.
    app.ws(wsPath, { message_type: 'String' }, (ws) => {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'connected', clients: clients.size }));
        ws.on('message', (message: string) => {
            for (const client of clients) client.send(message);
        });
        ws.on('close', () => {
            clients.delete(ws);
        });
    });

    // Static client with SPA fallback — anything that isn't a real file serves index.html.
    app.get('/*', (request, response) => {
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

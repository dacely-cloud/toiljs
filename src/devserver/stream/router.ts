/**
 * The dev STREAM ROUTER (doc 08 sections 4.1/4.2): the `streamModule` that `wireStreams` drives. It
 * owns the `toilstream.catalog` route table + a single resident-box {@link StreamDevHost} for the app's
 * `release-stream.wasm`, and turns a route-matched WebSocket upgrade into a {@link StreamWsSession}
 * driving that box. `matchRoute` (4.2) lets `wireStreams` tell a `@stream` upgrade from a Vite-HMR one;
 * both the catalog and the box mtime-reload so a rebuild during `npm run dev` is picked up.
 */

import fs from 'node:fs';

import {
    matchStreamRoute,
    parseStreamCatalog,
    type StreamCatalog,
    type StreamDef,
} from './catalog.js';
import { StreamDevHost } from './manager.js';
import { StreamWsSession } from './ws.js';

/** The subset of the hyper-express `Websocket` the router drives (so it is unit-testable with a mock). */
export interface StreamWs {
    send(data: Buffer, isBinary: boolean): void;
    close(code: number): void;
    on(event: 'message', cb: (message: Buffer, isBinary: boolean) => void): void;
    on(event: 'close', cb: () => void): void;
}

/** The upgrade context `wireStreams` stamps for a stream-route upgrade (doc 08 4.1). */
export interface StreamUpgradeContext {
    readonly kind: 'stream';
    readonly route: string;
    readonly url: string;
    readonly authority: string;
}

export class StreamRouter {
    private catalog: StreamCatalog = new Map();
    private catalogMtimeMs = -1;
    private readonly host: StreamDevHost;
    private connSeq = 0;

    constructor(private readonly streamWasmPath: string) {
        this.host = new StreamDevHost(streamWasmPath);
        this.refreshCatalog();
    }

    /** Live stream connections (diagnostics / tests). */
    get activeConnections(): number {
        return this.host.activeConnections;
    }

    /** doc 08 4.2: match a request path to a `@stream` route (re-reading the catalog on a rebuild), or
     *  `null` when it is not a stream route (the upgrade is then proxied to Vite). */
    matchRoute(path: string): StreamDef | null {
        this.refreshCatalog();
        return matchStreamRoute(this.catalog, path);
    }

    /** Handle a route-matched upgrade: open a resident box (`@connect`) and bridge the socket to it
     *  (inbound frame -> `@message` -> reply frames out; socket close -> `@close`). On a `@connect`
     *  reject the session closes the socket and registers no box. */
    onUpgrade(ws: StreamWs, ctx: StreamUpgradeContext): void {
        const connId = `s${String(++this.connSeq)}`;
        const q = ctx.url.indexOf('?');
        const path = q >= 0 ? ctx.url.slice(0, q) : ctx.url;
        const session = new StreamWsSession(this.host, connId, ctx.authority, path, {
            send: (frame) => {
                ws.send(frame, true);
            },
            close: (code) => {
                ws.close(code);
            },
        });
        if (!session.onOpen()) return; // rejected -> socket closed, nothing resident
        ws.on('message', (message: Buffer) => {
            session.onMessage(message);
        });
        ws.on('close', () => {
            session.onClose();
        });
    }

    /** (Re)read the route table when the artifact mtime changes (mirrors `DaemonHost.refresh`). */
    private refreshCatalog(): void {
        let mtimeMs: number;
        try {
            mtimeMs = fs.statSync(this.streamWasmPath).mtimeMs;
        } catch {
            this.catalog = new Map();
            this.catalogMtimeMs = -1;
            return;
        }
        if (mtimeMs === this.catalogMtimeMs && this.catalog.size > 0) return;
        try {
            this.catalog = parseStreamCatalog(fs.readFileSync(this.streamWasmPath));
        } catch {
            this.catalog = new Map();
        }
        this.catalogMtimeMs = mtimeMs;
    }
}

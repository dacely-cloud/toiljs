/**
 * doc 08 section 4.1: the stream-aware WebSocket router that REPLACES `wireWebsocketProxy` when the dev
 * process serves streams. It intercepts upgrades whose path matches a `@stream` route (via the
 * {@link StreamRouter}) and drives them as resident-box connections; every OTHER upgrade (Vite HMR) is
 * piped upstream EXACTLY as before ({@link pipeToVite}), so HMR is byte-for-byte unchanged. The branch
 * is decided in `app.upgrade` (which stamps `ctx.kind`) and dispatched in the single catch-all
 * `app.ws` handler, mirroring the existing proxy's structure.
 */

import { type Request, type Response, type Server, type Websocket } from '@dacely/hyper-express';

import { pipeToVite, type ViteTarget } from '../http/proxy.js';
import { type StreamRouter, type StreamUpgradeContext, type StreamWs } from './router.js';

/** Whether this dev process serves streams (doc 08 4.1): `regional` / `continental` / `all`. An
 *  L1 (`hot`) or L4 (`daemon`) dev process does NOT - it rejects/redirects the upgrade. */
export function streamEmulationEnabled(nodeMode: string): boolean {
    return nodeMode === 'regional' || nodeMode === 'continental' || nodeMode === 'all';
}

export function wireStreams(app: Server, vite: ViteTarget, router: StreamRouter): void {
    app.upgrade('/*', (request: Request, response: Response) => {
        const def = router.matchRoute(request.path);
        if (def !== null) {
            // A @stream route: stamp the stream context; the ws handler drives the resident box.
            response.upgrade({
                kind: 'stream',
                route: def.route,
                url: request.url,
                authority: request.headers['host'] ?? '',
            });
        } else {
            // Anything else (Vite HMR): the existing proxy context, unchanged.
            response.upgrade({
                kind: 'vite',
                url: request.url,
                protocol: request.headers['sec-websocket-protocol'] ?? '',
            });
        }
    });

    app.ws(
        '/*',
        // idle_timeout 0: the stream emulator drives liveness itself; the Vite branch never idles out.
        { message_type: 'Buffer', idle_timeout: 0, max_payload_length: 16 * 1024 * 1024 },
        (ws: Websocket) => {
            const ctx = ws.context as { kind?: string };
            if (ctx.kind === 'stream') {
                router.onUpgrade(
                    ws as unknown as StreamWs,
                    ws.context as unknown as StreamUpgradeContext,
                );
            } else {
                pipeToVite(ws, vite, ws.context as { url: string; protocol: string });
            }
        },
    );
}

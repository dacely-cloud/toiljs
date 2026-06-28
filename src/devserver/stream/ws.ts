/**
 * Transport adapter that bridges ONE dev WebSocket connection to the {@link StreamDevHost} session
 * driver. It is the per-socket glue the dev WS endpoint instantiates: socket-open -> `acceptUpgrade`
 * (close on a `@connect`/gate reject), inbound frame -> `dispatch` (send reply frames back, or close
 * on a reject/trap close code), socket-close -> `@close` + drop. It owns NO transport itself - the
 * caller passes a {@link StreamWsTransport} of `send`/`close` callbacks - so it is unit-testable
 * without a live socket and reusable across whatever WS/WebTransport the endpoint ends up speaking.
 *
 * The endpoint that wires hyper-express `app.ws` to this (the URL convention + coexistence with the
 * Vite-HMR catch-all proxy + a `streamWasmFile` config) is the remaining live-server step; this is the
 * transport-agnostic core it drives.
 */

import type { StreamDevHost } from './manager.js';

/** The socket-side primitives this adapter needs: send one binary frame, and close with a code. */
export interface StreamWsTransport {
    /** Send one outbound binary frame to the client. */
    send(frame: Buffer): void;
    /** Close the connection with a `0x02xx` stream close code. */
    close(code: number): void;
}

export class StreamWsSession {
    private open = false;

    constructor(
        private readonly host: StreamDevHost,
        private readonly connId: string,
        private readonly authority: string,
        private readonly path: string,
        private readonly transport: StreamWsTransport,
    ) {}

    /** Whether the connection is accepted + live. */
    get isOpen(): boolean {
        return this.open;
    }

    /**
     * Socket open: accept the upgrade (node gate is the endpoint's job; this drives the box). On a
     * `@connect`/artifact reject the connection is closed with the code and no box is held. Returns
     * whether the connection was accepted.
     */
    onOpen(): boolean {
        const up = this.host.acceptUpgrade(this.connId, this.authority, this.path);
        if (up.kind === 'rejected') {
            for (const frame of up.initialEgress) this.transport.send(frame);
            this.transport.close(up.code);
            return false;
        }
        this.open = true;
        for (const frame of up.initialEgress) this.transport.send(frame);
        return true;
    }

    /** An inbound binary frame: dispatch it; send the reply frames, or close on a reject/trap code. */
    onMessage(inbound: Buffer): void {
        if (!this.open) return;
        const r = this.host.dispatch(this.connId, inbound);
        if (r.kind === 'reply') {
            for (const frame of r.frames) this.transport.send(frame);
        } else if (r.kind === 'close') {
            // A guest reject or a TRAP close: close the socket; the socket-close event runs onClose,
            // which fires @close + drops the box (a no-op if a trap already discarded it).
            this.open = false;
            this.transport.close(r.code);
        }
        // 'noConnection' cannot occur for a live, accepted session.
    }

    /** Socket close (client-initiated or after our own close): fire `@close` + drop the box. */
    onClose(): void {
        if (!this.open && !this.host.has(this.connId)) return;
        this.open = false;
        this.host.close(this.connId);
    }
}

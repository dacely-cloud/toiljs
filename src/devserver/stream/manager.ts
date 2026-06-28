/**
 * Dev STREAM connection driver: the resident per-connection box lifecycle for the dev server, a
 * faithful port of the edge session driver `StreamWorker` (`toil-backend` `src/wasm/stream/worker.rs`)
 * and a sibling of `DaemonHost`. It owns one resident {@link DevStreamBox} per live connection (state
 * persists across that connection's events) and mtime-reloads the `release-stream.wasm` artifact so a
 * rebuild during `npm run dev` is picked up - a NEW connection then gets the new artifact while live
 * connections keep their resident box (mirroring the edge's per-connection pinning).
 *
 * It mirrors `StreamWorker`'s decisions byte-for-byte where they matter in dev: `acceptUpgrade` fires
 * `@connect` with the connect context and HONORS the guest accept/reject (the `@connect` bridge);
 * `dispatch` returns reply frames, a guest-reject close, or a TRAP-induced `STREAM_HOOK_TRAPPED` close
 * that discards the poisoned box. The edge-only concerns it omits (the node-mode gate, the per-node
 * RAM admission, and gas-metered kills) do not apply to a single-process dev server: dev serves one
 * app, has no RAM budget, and Node's `WebAssembly` has no gas middleware (a runaway loop hangs in dev,
 * only a real trap surfaces).
 *
 * Transport-agnostic: the dev WebSocket endpoint calls `acceptUpgrade` on a new socket, `dispatch` per
 * inbound frame (feeding the reply frames back out, or closing on a close code), and `close`/
 * `disconnect` on teardown. Kept transport-free so it is unit-testable without a socket.
 */

import fs from 'node:fs';

import { DevStreamBox } from './index.js';

/** `0x0208 STREAM_REJECTED`: the upgrade is refused for a non-`@connect` reason (no artifact / load
 *  failure). Matches the edge `STREAM_REJECTED`. */
export const STREAM_REJECTED = 0x0208;
/** `0x0200 STREAM_HOOK_TRAPPED`: a hook TRAPPED (unreachable / OOB / abort); the box is discarded and
 *  the connection closed. Matches the edge `STREAM_HOOK_TRAPPED`. */
export const STREAM_HOOK_TRAPPED = 0x0200;

/** The outcome of an upgrade accept attempt (mirrors the edge `StreamUpgradeOutcome`). */
export type StreamUpgradeOutcome =
    | { readonly kind: 'accepted'; readonly streamId: bigint; readonly initialEgress: Buffer[] }
    | { readonly kind: 'rejected'; readonly code: number; readonly initialEgress: Buffer[] };

/** The outcome of driving one inbound frame (mirrors the edge `StreamDatagramOutcome`). */
export type StreamDispatchResult =
    | { readonly kind: 'reply'; readonly frames: Buffer[] }
    | { readonly kind: 'close'; readonly code: number }
    | { readonly kind: 'noConnection' };

interface ResidentConn {
    readonly box: DevStreamBox;
    readonly streamId: bigint;
}

export class StreamDevHost {
    private bytes: Buffer | null = null;
    private loadedMtimeMs = -1;
    private readonly conns = new Map<string, ResidentConn>();
    /** Host-assigned stream id source: monotonic, never 0 (05 section 2.2). */
    private nextStreamId = 1n;

    constructor(private readonly streamWasmPath: string) {}

    /** Number of live stream connections. */
    get activeConnections(): number {
        return this.conns.size;
    }

    /** Whether a connection is live under `connId`. */
    has(connId: string): boolean {
        return this.conns.has(connId);
    }

    /**
     * Accept (or reject) an upgrade for `authority` + `path`, mirroring `StreamWorker::accept_upgrade`:
     * (re)load the artifact on mtime change, instantiate a resident box, fire `@connect` WITH the
     * connect context, and HONOR the guest's accept/reject. Returns the host-assigned stream id on
     * accept, plus any initial egress staged by `@connect`, or a `0x02xx` reject code. Fails closed
     * (no connection registered, box dropped) on a missing/unreadable artifact (`0x0208`), a
     * `@connect` reject (the guest's code), or a load/connect trap (`0x0200`). Throws only on a
     * duplicate `connId`.
     */
    acceptUpgrade(connId: string, authority: string, path: string): StreamUpgradeOutcome {
        if (this.conns.has(connId))
            throw new Error(`stream connection '${connId}' is already open`);
        this.refresh();
        if (!this.bytes) return { kind: 'rejected', code: STREAM_REJECTED, initialEgress: [] };
        let box: DevStreamBox;
        try {
            box = DevStreamBox.load(this.bytes);
        } catch {
            return { kind: 'rejected', code: STREAM_REJECTED, initialEgress: [] };
        }
        const streamId = this.allocStreamId();
        let outcome;
        try {
            outcome = box.onConnect(streamId, authority, path);
        } catch {
            return { kind: 'rejected', code: STREAM_HOOK_TRAPPED, initialEgress: [] }; // @connect trapped
        }
        if (outcome.kind === 'reject') {
            return { kind: 'rejected', code: outcome.code, initialEgress: outcome.initialEgress };
        }
        this.conns.set(connId, { box, streamId });
        return { kind: 'accepted', streamId, initialEgress: outcome.initialEgress };
    }

    /**
     * Drive an inbound frame into the connection's `@message` hook, mirroring
     * `StreamWorker::dispatch_datagram`: `reply` frames (to feed back out), a guest-`reject` `close`, a
     * TRAP-induced `close` (discarding the poisoned box), or `noConnection` for an unknown id.
     */
    dispatch(connId: string, inbound: Buffer): StreamDispatchResult {
        const conn = this.conns.get(connId);
        if (!conn) return { kind: 'noConnection' };
        try {
            const out = conn.box.onMessage(conn.streamId, inbound);
            if (out.kind === 'reply') return { kind: 'reply', frames: out.frames };
            return { kind: 'close', code: out.code };
        } catch {
            // The @message hook TRAPPED (a real wasm trap; dev has no gas middleware) -> discard the
            // poisoned box + close, mirroring the edge's STREAM_HOOK_TRAPPED (05 7.4).
            this.conns.delete(connId);
            return { kind: 'close', code: STREAM_HOOK_TRAPPED };
        }
    }

    /** Graceful close: fire `@close` and drop the box. No-op if the connection is gone. */
    close(connId: string): void {
        const conn = this.conns.get(connId);
        if (!conn) return;
        try {
            conn.box.onClose(conn.streamId);
        } catch {
            // a trapping @close still tears the connection down
        }
        this.conns.delete(connId);
    }

    /** Abrupt teardown: fire `@disconnect` and drop the box. No-op if the connection is gone. */
    disconnect(connId: string): void {
        const conn = this.conns.get(connId);
        if (!conn) return;
        try {
            conn.box.onDisconnect(conn.streamId);
        } catch {
            // a trapping @disconnect still tears the connection down
        }
        this.conns.delete(connId);
    }

    /** (Re)read the artifact bytes when its mtime changes (mirrors `DaemonHost.refresh`). Clears the
     *  bytes when the file is missing; leaves live connections' resident boxes untouched. */
    private refresh(): void {
        let mtimeMs: number;
        try {
            mtimeMs = fs.statSync(this.streamWasmPath).mtimeMs;
        } catch {
            this.bytes = null;
            this.loadedMtimeMs = -1;
            return;
        }
        if (mtimeMs === this.loadedMtimeMs && this.bytes) return;
        this.bytes = fs.readFileSync(this.streamWasmPath);
        this.loadedMtimeMs = mtimeMs;
    }

    private allocStreamId(): bigint {
        const id = this.nextStreamId;
        this.nextStreamId = id + 1n;
        return id;
    }
}

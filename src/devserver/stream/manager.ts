/**
 * Dev STREAM connection manager: the resident per-connection box lifecycle for the dev server, the
 * dev analogue of the edge `StreamConnManager` (`toil-backend` `src/wasm/stream/manager.rs`) and a
 * sibling of `DaemonHost`. It owns one resident {@link DevStreamBox} per live connection (state
 * persists across that connection's events) and mtime-reloads the `release-stream.wasm` artifact so a
 * rebuild during `npm run dev` is picked up - a NEW connection then gets the new artifact while live
 * connections keep their resident box (mirroring the edge's per-connection pinning).
 *
 * Transport-agnostic: the (future) dev WebSocket/WebTransport endpoint calls `open` on a new socket,
 * `message` per inbound frame (feeding the reply frames back out), and `close`/`disconnect` on
 * teardown. Kept transport-free so it is unit-testable without a socket.
 */

import fs from 'node:fs';

import { DevStreamBox, type StreamMessageOutcome } from './index.js';

interface ResidentConn {
    readonly box: DevStreamBox;
    /** The host-assigned stream id passed to this connection's lifecycle dispatches (never 0). */
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
     * Open a connection: (re)load the artifact on mtime change, instantiate a resident box, fire
     * `@connect`, and register it under `connId`. Returns the host-assigned stream id. Throws (fails
     * closed, no connection) if the artifact is missing/unreadable, `connId` is already open, or the
     * box fails to load.
     */
    open(connId: string): bigint {
        if (this.conns.has(connId)) throw new Error(`stream connection '${connId}' is already open`);
        this.refresh();
        if (!this.bytes) throw new Error(`no stream artifact at ${this.streamWasmPath}`);
        const box = DevStreamBox.load(this.bytes);
        const streamId = this.allocStreamId();
        box.onConnect(streamId);
        this.conns.set(connId, { box, streamId });
        return streamId;
    }

    /** Drive one inbound frame into the connection's `@message` hook and return the bridge outcome. */
    message(connId: string, inbound: Buffer): StreamMessageOutcome {
        const conn = this.conns.get(connId);
        if (!conn) throw new Error(`no live stream connection '${connId}'`);
        return conn.box.onMessage(conn.streamId, inbound);
    }

    /** Graceful close: fire `@close` and drop the box. No-op if the connection is gone. */
    close(connId: string): void {
        const conn = this.conns.get(connId);
        if (!conn) return;
        conn.box.onClose(conn.streamId);
        this.conns.delete(connId);
    }

    /** Abrupt teardown: fire `@disconnect` and drop the box. No-op if the connection is gone. */
    disconnect(connId: string): void {
        const conn = this.conns.get(connId);
        if (!conn) return;
        conn.box.onDisconnect(conn.streamId);
        this.conns.delete(connId);
    }

    /** (Re)read the artifact bytes when its mtime changes (mirrors `DaemonHost.refresh` /
     *  `WasmServerModule`). Clears the bytes when the file is missing (a new connection then fails
     *  closed) but leaves live connections' resident boxes untouched. */
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

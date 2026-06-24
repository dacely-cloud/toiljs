/**
 * Dev STREAM (L2/L3) emulation: load a `release-stream.wasm` hot artifact into a resident per-connection
 * box and drive its lifecycle (`@connect` / `@message` / `@close` / `@disconnect`) through the
 * `stream_dispatch` export + the ingress/egress RING BRIDGE - the dev-side port of the production
 * `StreamBox` (`toil-backend` `src/wasm/stream/runtime.rs`). The ring wire format (RingControl 32B +
 * RingFrame 12B + drained-reset + the packed-i64 reject bridge) AND the `@connect` info-block ABI are
 * replicated BYTE-FOR-BYTE so a `@stream` app behaves identically under `npm run dev` and at the edge.
 *
 * RESIDENT: one box per connection, NEVER reset between events (linear memory persists across
 * connect -> message -> close); a fresh `WebAssembly.Instance` per connection IS that residency.
 *
 * DEV LIMITATION vs the edge: Node's `WebAssembly` has NO gas-metering middleware, so a runaway guest
 * loop is NOT gas-killed in dev (it hangs) - only a genuine wasm TRAP (unreachable / OOB / abort)
 * surfaces, which the caller turns into a `STREAM_HOOK_TRAPPED` close. Packet gas, chunk reassembly,
 * `@channel`, and the `stream.*` host imports are deferred exactly as on the edge.
 */

import { parseSurface } from '../wasm/surface.js';
import { buildStreamImports, freshStreamBoxState, type StreamBoxState } from './host.js';

// --- the stream_dispatch ABI (toil-backend src/wasm/stream/section.rs) ---
const EVENT_CONNECT = 1;
const EVENT_MESSAGE = 2;
const EVENT_CLOSE = 3;
const EVENT_DISCONNECT = 4;

// --- ring wire format (05 sections 5-6; toil-backend src/wasm/stream/runtime.rs) ---
const RING_CTRL_BYTES = 32; // RingControl header
const RING_FRAME_HEADER = 12; // RingFrame header
const RING_MAGIC = 0x3147_4e52; // "RNG1" little-endian
const RING_VERSION = 1;
const RC_WRITE = 12; // write_cursor offset in RingControl
const RC_READ = 16; // read_cursor offset
const FRAME_TYPE_DATA_RELIABLE = 1;
const MAX_STREAM_FRAME_LEN = 65536; // 64 KiB per egress frame (05 6.1)

// --- @connect info-block ABI (05 section 2.2; toil-backend runtime.rs write_connect_info) ---
// Layout: [u64 stream_id][u8 transport][u8 _][u16 auth_len][u16 path_len][u16 _] then auth + path UTF8.
const SI_TRANSPORT = 8;
const SI_AUTH_LEN = 10;
const SI_PATH_LEN = 12;
const SI_RESERVED2 = 14;
const SI_BODY = 16;
const SI_TRANSPORT_WEBTRANSPORT = 1; // the v1 transport (the dev emulates it)

/**
 * Decode a guest's NEGATIVE `stream_dispatch` return into a `0x02xx` reject/close code (the Part-3
 * bridge `-(0x10000 + code)`), clamped to the stream range `0x0200..=0x02FF`; an out-of-range value
 * normalizes to `0x0208 STREAM_REJECTED`, mirroring `toil-backend` `decode_reject_code`.
 */
export function decodeRejectCode(rc: bigint): number {
    const raw = Number((-rc - 0x10000n) & 0xffffn);
    return raw >= 0x0200 && raw <= 0x02ff ? raw : 0x0208;
}

interface StreamExports {
    readonly memory: WebAssembly.Memory;
    readonly stream_dispatch: (eventKind: number, lo: number, hi: number) => bigint;
    readonly stream_ring_offset?: () => number;
    readonly stream_ring_capacity?: () => number;
    readonly stream_egress_offset?: () => number;
    readonly stream_egress_capacity?: () => number;
    readonly stream_info_offset?: () => number;
    readonly stream_info_capacity?: () => number;
}

interface Rings {
    readonly ingressOff: number;
    readonly ingressCap: number;
    readonly egressOff: number;
    readonly egressCap: number;
}

interface StreamInfo {
    readonly offset: number;
    readonly cap: number;
}

/** A `@message` dispatch outcome: the drained egress reply frames, or a guest reject code. */
export type StreamMessageOutcome =
    | { readonly kind: 'reply'; readonly frames: Buffer[] }
    | { readonly kind: 'reject'; readonly code: number };

/** A `@connect` outcome: the guest accepted (the box is usable) or rejected with a `0x02xx` code. */
export type StreamConnectOutcome =
    | { readonly kind: 'accept' }
    | { readonly kind: 'reject'; readonly code: number };

export class DevStreamBox {
    private constructor(
        private readonly exports: StreamExports,
        private readonly _state: StreamBoxState,
        private readonly rings: Rings | null,
        private readonly streamInfo: StreamInfo | null,
    ) {}

    /** Compile + instantiate a resident stream box from a HOT `release-stream.wasm`. Fails closed: a
     *  cold artifact, a missing `stream_dispatch`/`memory`, or a bad module throws. */
    static load(wasm: Buffer): DevStreamBox {
        const surface = parseSurface(wasm);
        if (surface === 'invalid' || surface.targetMode !== 'hot') {
            throw new Error('stream box requires a hot artifact with a valid toil.surface');
        }
        const ref: { memory: WebAssembly.Memory | null } = { memory: null };
        const state = freshStreamBoxState();
        const module = new WebAssembly.Module(new Uint8Array(wasm));
        const instance = new WebAssembly.Instance(module, buildStreamImports(ref, state));
        const exports = instance.exports as unknown as StreamExports;
        if (
            typeof exports.stream_dispatch !== 'function' ||
            !(exports.memory instanceof WebAssembly.Memory)
        ) {
            throw new Error("stream artifact must export 'stream_dispatch' + 'memory'");
        }
        ref.memory = exports.memory;
        const rings = DevStreamBox.resolveRings(exports);
        const streamInfo = DevStreamBox.resolveStreamInfo(exports);
        const box = new DevStreamBox(exports, state, rings, streamInfo);
        if (rings) box.stampRings();
        return box;
    }

    /** Whether the box carries the ring runtime (a pre-bridge fixture omits the exports). */
    get hasRings(): boolean {
        return this.rings !== null;
    }

    /** Whether the box carries the `@connect` info-block bridge (a `@connect(StreamInbound)` hook). */
    get hasConnectBridge(): boolean {
        return this.streamInfo !== null;
    }

    /**
     * Fire `@connect`: write the connect-info block (stream id + transport + authority + path) into the
     * guest's info region, dispatch `EVENT_CONNECT`, and decode the `StreamOutbound` accept/reject. On
     * accept, clear any `@connect`-staged egress (initial-egress is deferred, like the edge) so it does
     * not contaminate the first `@message` reply. A box without the bridge runs `@connect` context-free
     * (the write is a no-op) and always accepts unless it returns a negative code.
     */
    onConnect(streamId: bigint, authority: string, path: string): StreamConnectOutcome {
        this.writeConnectInfo(streamId, authority, path);
        const rc = this.dispatch(EVENT_CONNECT, streamId);
        if (rc < 0n) return { kind: 'reject', code: decodeRejectCode(rc) };
        this.resetEgressRing();
        return { kind: 'accept' };
    }

    /** Fire `@close` (graceful close). */
    onClose(streamId: bigint): bigint {
        return this.dispatch(EVENT_CLOSE, streamId);
    }

    /** Fire `@disconnect` (abrupt teardown). */
    onDisconnect(streamId: bigint): bigint {
        return this.dispatch(EVENT_DISCONNECT, streamId);
    }

    /** Drive the raw-bytes `@message` bridge: write `inbound` as one DATA_RELIABLE frame into the
     *  ingress ring, fire `@message`, then drain the egress ring (reply) or surface the reject code.
     *  A genuine wasm trap propagates (the caller maps it to a STREAM_HOOK_TRAPPED close). */
    onMessage(streamId: bigint, inbound: Buffer): StreamMessageOutcome {
        if (!this.rings) {
            throw new Error('stream box has no ring runtime; the message bridge is unavailable');
        }
        this.ingressWrite(inbound);
        const ret = this.dispatch(EVENT_MESSAGE, streamId);
        if (ret < 0n) return { kind: 'reject', code: decodeRejectCode(ret) };
        return { kind: 'reply', frames: this.egressDrain() };
    }

    private dispatch(eventKind: number, streamId: bigint): bigint {
        const lo = Number(streamId & 0xffff_ffffn) | 0;
        const hi = Number((streamId >> 32n) & 0xffff_ffffn) | 0;
        return this.exports.stream_dispatch(eventKind, lo, hi);
    }

    private static resolveRings(e: StreamExports): Rings | null {
        if (
            typeof e.stream_ring_offset !== 'function' ||
            typeof e.stream_ring_capacity !== 'function' ||
            typeof e.stream_egress_offset !== 'function' ||
            typeof e.stream_egress_capacity !== 'function'
        ) {
            return null;
        }
        return {
            ingressOff: e.stream_ring_offset() >>> 0,
            ingressCap: e.stream_ring_capacity() >>> 0,
            egressOff: e.stream_egress_offset() >>> 0,
            egressCap: e.stream_egress_capacity() >>> 0,
        };
    }

    private static resolveStreamInfo(e: StreamExports): StreamInfo | null {
        if (typeof e.stream_info_offset !== 'function' || typeof e.stream_info_capacity !== 'function') {
            return null;
        }
        return { offset: e.stream_info_offset() >>> 0, cap: e.stream_info_capacity() >>> 0 };
    }

    private stampRings(): void {
        const rings = this.rings;
        if (!rings) return;
        this.stampOne(rings.ingressOff, rings.ingressCap);
        this.stampOne(rings.egressOff, rings.egressCap);
    }

    private stampOne(base: number, cap: number): void {
        const dv = new DataView(this.exports.memory.buffer);
        dv.setUint32(base + 0, RING_MAGIC, true);
        dv.setUint16(base + 4, RING_VERSION, true);
        dv.setUint16(base + 6, 0, true); // flags
        dv.setUint32(base + 8, cap, true); // capacity
        dv.setUint32(base + RC_WRITE, 0, true);
        dv.setUint32(base + RC_READ, 0, true);
    }

    /** Write the `@connect` info block into the guest's info region (no-op if the box carries none).
     *  Authority + path are bounded into `[SI_BODY, cap)` - truncated to fit, never an OOB write. */
    private writeConnectInfo(streamId: bigint, authority: string, path: string): void {
        const info = this.streamInfo;
        if (!info) return;
        const base = info.offset;
        const body = Math.max(0, info.cap - SI_BODY);
        const authBytes = Buffer.from(authority, 'utf8');
        const authLen = Math.min(authBytes.length, 0xffff, body);
        const pathBytes = Buffer.from(path, 'utf8');
        const pathLen = Math.min(pathBytes.length, 0xffff, body - authLen);
        const dv = new DataView(this.exports.memory.buffer);
        dv.setBigUint64(base + 0, streamId, true);
        dv.setUint8(base + SI_TRANSPORT, SI_TRANSPORT_WEBTRANSPORT);
        dv.setUint8(base + SI_TRANSPORT + 1, 0); // reserved
        dv.setUint16(base + SI_AUTH_LEN, authLen, true);
        dv.setUint16(base + SI_PATH_LEN, pathLen, true);
        dv.setUint16(base + SI_RESERVED2, 0, true); // reserved
        const memU8 = new Uint8Array(this.exports.memory.buffer);
        if (authLen > 0) memU8.set(authBytes.subarray(0, authLen), base + SI_BODY);
        if (pathLen > 0) memU8.set(pathBytes.subarray(0, pathLen), base + SI_BODY + authLen);
    }

    /** Zero the egress ring cursors, discarding any staged frames. Safe between dispatches (the guest,
     *  the sole egress producer, is idle). */
    private resetEgressRing(): void {
        const rings = this.rings;
        if (!rings) return;
        const dv = new DataView(this.exports.memory.buffer);
        dv.setUint32(rings.egressOff + RC_WRITE, 0, true);
        dv.setUint32(rings.egressOff + RC_READ, 0, true);
    }

    /** Host (producer) writes ONE inbound RingFrame into the ingress ring with the drained-reset
     *  (host owns write_cursor; reset read_cursor only when the guest has drained). */
    private ingressWrite(inbound: Buffer): void {
        const rings = this.rings;
        if (!rings) throw new Error('ingressWrite: no ring runtime');
        const { ingressOff: base, ingressCap: cap } = rings;
        const dv = new DataView(this.exports.memory.buffer);
        const n = inbound.length;
        const frameLen = RING_FRAME_HEADER + n;
        if (frameLen > cap) {
            throw new Error(`inbound frame (${String(frameLen)} B) exceeds ingress capacity`);
        }
        const w0 = dv.getUint32(base + RC_WRITE, true);
        const r0 = dv.getUint32(base + RC_READ, true);
        let w: number;
        if (r0 === w0) {
            dv.setUint32(base + RC_WRITE, 0, true);
            dv.setUint32(base + RC_READ, 0, true);
            w = 0;
        } else {
            w = w0;
        }
        if (w + frameLen > cap) throw new Error('ingress frame would not fit (v1 is no-wrap)');
        const f = base + RING_CTRL_BYTES + w;
        dv.setUint8(f + 0, RING_VERSION);
        dv.setUint8(f + 1, FRAME_TYPE_DATA_RELIABLE);
        dv.setUint16(f + 2, 0, true); // flags
        dv.setUint32(f + 4, n, true); // length
        dv.setUint32(f + 8, 0, true); // msg_seq
        if (n > 0) new Uint8Array(this.exports.memory.buffer, f + RING_FRAME_HEADER, n).set(inbound);
        dv.setUint32(base + RC_WRITE, w + frameLen, true);
    }

    /** Host (consumer) drains every egress RingFrame the guest staged, copying each payload out and
     *  advancing the host-owned read_cursor. The guest does the drained-reset on its next write. */
    private egressDrain(): Buffer[] {
        const rings = this.rings;
        if (!rings) return [];
        const { egressOff: base, egressCap: cap } = rings;
        const dv = new DataView(this.exports.memory.buffer);
        const w = dv.getUint32(base + RC_WRITE, true);
        let r = dv.getUint32(base + RC_READ, true);
        const frames: Buffer[] = [];
        while (r < w) {
            const f = base + RING_CTRL_BYTES + r;
            if (r + RING_FRAME_HEADER > cap) break; // header must fit the frame region
            const len = dv.getUint32(f + 4, true);
            if (len > MAX_STREAM_FRAME_LEN) break; // over-cap frame (contained, not over-read)
            const span = RING_FRAME_HEADER + len;
            if (r + span > cap) break; // payload must fit
            const payloadOff = f + RING_FRAME_HEADER;
            frames.push(Buffer.from(new Uint8Array(this.exports.memory.buffer, payloadOff, len)));
            r += span;
        }
        dv.setUint32(base + RC_READ, r, true);
        return frames;
    }
}

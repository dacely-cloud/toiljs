/**
 * Dev STREAM (L2/L3) emulation: load a `release-stream.wasm` hot artifact into a resident per-connection
 * box and drive its lifecycle (`@connect` / `@message` / `@close` / `@disconnect`) through the
 * `stream_dispatch` export + the ingress/egress RING BRIDGE - the dev-side port of the production
 * `StreamBox` (`toil-backend` `src/wasm/stream/runtime.rs`). The ring wire format (RingControl 32B +
 * RingFrame 12B + the drained-reset semantics + the packed-i64 reject bridge) is replicated
 * BYTE-FOR-BYTE so a `@stream` app behaves identically under `npm run dev` and at the edge.
 *
 * RESIDENT: one box per connection, NEVER reset between events (linear memory persists across
 * connect -> message -> close); a fresh `WebAssembly.Instance` per connection IS that residency.
 *
 * DEFERRED (mirrors the edge): packet gas, chunk reassembly, `@channel`, and the `stream.*` host
 * imports. A trapping hook surfaces as a thrown error the caller turns into a connection close.
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

interface StreamExports {
    readonly memory: WebAssembly.Memory;
    readonly stream_dispatch: (eventKind: number, lo: number, hi: number) => bigint;
    readonly stream_ring_offset?: () => number;
    readonly stream_ring_capacity?: () => number;
    readonly stream_egress_offset?: () => number;
    readonly stream_egress_capacity?: () => number;
}

interface Rings {
    readonly ingressOff: number;
    readonly ingressCap: number;
    readonly egressOff: number;
    readonly egressCap: number;
}

/** A `@message` dispatch outcome: the drained egress reply frames, or a guest reject code. */
export type StreamMessageOutcome =
    | { readonly kind: 'reply'; readonly frames: Buffer[] }
    | { readonly kind: 'reject'; readonly code: number };

export class DevStreamBox {
    private constructor(
        private readonly exports: StreamExports,
        private readonly _state: StreamBoxState,
        private readonly rings: Rings | null,
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
        const box = new DevStreamBox(exports, state, rings);
        if (rings) box.stampRings();
        return box;
    }

    /** Whether the box carries the ring runtime (a pre-bridge fixture omits the exports). */
    get hasRings(): boolean {
        return this.rings !== null;
    }

    /** Fire `@connect` (a new connection). Returns the packed-i64 dispatch result. */
    onConnect(streamId: bigint): bigint {
        return this.dispatch(EVENT_CONNECT, streamId);
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
     *  ingress ring, fire `@message`, then drain the egress ring (reply) or surface the reject code. */
    onMessage(streamId: bigint, inbound: Buffer): StreamMessageOutcome {
        if (!this.rings) {
            throw new Error('stream box has no ring runtime; the message bridge is unavailable');
        }
        this.ingressWrite(inbound);
        const ret = this.dispatch(EVENT_MESSAGE, streamId);
        if (ret < 0n) {
            // Part-3 reject bridge: code = (-ret) - 0x10000.
            return { kind: 'reject', code: Number((-ret - 0x10000n) & 0xffffn) };
        }
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

    /** Stamp both RingControls (magic + version + capacity, cursors zeroed) - the host's job at box
     *  build, mirroring the edge. */
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

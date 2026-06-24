/**
 * Parse a compiled HOT server wasm's `toilstream.catalog` custom section into the dev stream router's
 * route table (doc 08 section 3.1; emitted by the toilscript hot pass per RECONCILIATION Part 5 when
 * any `@stream` class exists). The dev router keys on `route` (the `@stream` class's fixed mount path)
 * to intercept matching WebSocket upgrades (section 4.1/4.2) and ignore the rest (Vite HMR).
 *
 * Byte layout (Part 5, all little-endian; mirrors the toilscript emitter + the edge decoder):
 *
 *   u16 format_version (= 1)
 *   u16 n_streams
 *   per stream:
 *     str name                     (the @stream class name)
 *     str route                    (the mount path, e.g. "/echo")
 *     u8  hook_presence_bitmask    (bit0 connect, bit1 message, bit2 close, bit3 disconnect)
 *     u8  declared_scope           (0 = L2 regional, 1 = L3 continental)
 *     u8  message_mode             (0 = raw bytes default, 1 = @data-typed)
 *     u32 max_frame_bytes
 *     u32 ingress_ring_bytes
 *     u32 message_value_data_id    (0 when message_mode = 0)
 *     u32 message_schema_version   (0 when message_mode = 0)
 *     u16 stream_index
 *
 * Fails closed via `DataReader.ok`: a short read mid-record stops the loop and yields the cleanly
 * decoded prefix; an absent/unparseable section yields an empty map (the dev router serves no stream).
 */

import { DataReader } from 'toiljs/io';

import { customSection } from '../wasm/sections.js';

/** One `@stream` class's catalog entry (doc 08 section 3.1). */
export interface StreamDef {
    readonly name: string;
    readonly route: string;
    readonly hooks: {
        readonly connect: boolean;
        readonly message: boolean;
        readonly close: boolean;
        readonly disconnect: boolean;
    };
    readonly scope: 'regional' | 'continental';
    readonly messageMode: 'raw' | 'data';
    readonly maxFrameBytes: number;
    readonly ingressRingBytes: number;
    readonly messageValueDataId: number;
    readonly messageSchemaVersion: number;
    readonly streamIndex: number;
}

/** The dev router's route table, keyed by the `@stream` mount path. */
export type StreamCatalog = Map<string, StreamDef>;

/** Parse `toilstream.catalog` into a route table. Absent/unparseable -> empty (serve no stream). */
export function parseStreamCatalog(wasm: Buffer): StreamCatalog {
    const out: StreamCatalog = new Map();
    let sec: Buffer | null;
    try {
        sec = customSection(wasm, 'toilstream.catalog');
    } catch {
        return out;
    }
    if (sec === null) return out;
    const r = new DataReader(sec);
    r.readU16(); // format_version
    const n = r.readU16();
    for (let i = 0; i < n && r.ok; i++) {
        const name = r.readString();
        const route = r.readString();
        const bits = r.readU8();
        const scope = r.readU8() === 1 ? 'continental' : 'regional';
        const messageMode = r.readU8() === 1 ? 'data' : 'raw';
        const maxFrameBytes = r.readU32();
        const ingressRingBytes = r.readU32();
        const messageValueDataId = r.readU32();
        const messageSchemaVersion = r.readU32();
        const streamIndex = r.readU16();
        if (!r.ok) break;
        out.set(route, {
            name,
            route,
            hooks: {
                connect: (bits & 1) !== 0,
                message: (bits & 2) !== 0,
                close: (bits & 4) !== 0,
                disconnect: (bits & 8) !== 0,
            },
            scope,
            messageMode,
            maxFrameBytes,
            ingressRingBytes,
            messageValueDataId,
            messageSchemaVersion,
            streamIndex,
        });
    }
    return out;
}

/** Exact-path route match (doc 08 section 4.2): strip the query string, then look the path up in the
 *  catalog. Returns the matched `@stream` def, or `null` when the path is not a stream route (the dev
 *  router then proxies the upgrade to Vite). */
export function matchStreamRoute(catalog: StreamCatalog, path: string): StreamDef | null {
    const q = path.indexOf('?');
    const exact = q >= 0 ? path.slice(0, q) : path;
    return catalog.get(exact) ?? null;
}

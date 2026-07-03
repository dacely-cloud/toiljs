/**
 * Dev-server stand-in for the edge `env.analytics_read` host import
 * (toil-backend `src/wasm/host/import_functions/analytics.rs`). It returns a fixed
 * sample `TenantStats` frame so a tenant's wasm exercises the toilscript `Analytics`
 * API under `toiljs dev`. The frame is stashed into the SAME per-request result
 * buffer the `data.*` ops use (`db.lastResult`), so the guest drains it with the
 * existing `data.take_result`.
 *
 * Dev is intentionally PERMISSIVE: it returns sample data for ANY domain (own or
 * named) so a dashboard can be built locally. The real `dacely.com`-only
 * authorization is enforced host-side at the edge; the dev server has no
 * multi-tenant host resolution to authorize against.
 */
import type { DbDevState } from '../db/index.js';
import type { MemoryRef } from '../runtime/host.js';

/** Frame version + counter count, kept in lockstep with the edge (`analytics.rs` / `metric_id.rs`). */
const FRAME_VERSION = 2;
const METRIC_COUNTERS = 43;
/** MetricId indices we seed with sample data (others default 0). Mirrors the wire contract
 *  (counter ids 0..=42; gauge ids ConnectedStreamsAvg=43, CommittedMemoryAvg=45). */
const MID = {
    Requests: 0,
    BytesOutL1: 1,
    BytesInL1: 2,
    Status2xx: 3,
    Status4xx: 5,
    StaticHits: 7,
    WasmDispatches: 8,
    GasUsed: 12,
    DbOps: 13,
    DbReads: 14,
    DbWrites: 15,
    StreamBytesIn: 25,
    StreamBytesOut: 26,
    MemGrownBytes: 39,
    CacheHits: 41,
    CacheMisses: 42,
} as const;

interface DevTenantStats {
    life: bigint[]; // length METRIC_COUNTERS, indexed by MetricId
    connectedStreams: number;
    committedMemory: number;
    reqMinuteUsed: number;
    reqMinuteCap: number;
    reqDayUsed: number;
    reqDayCap: number;
    nowMs: number;
}

/** A plausible sample so a guest sees non-zero analytics under `toiljs dev`. */
function devStats(): DevTenantStats {
    const life = new Array<bigint>(METRIC_COUNTERS).fill(0n);
    life[MID.Requests] = 42n;
    life[MID.BytesOutL1] = 12345n;
    life[MID.BytesInL1] = 4096n;
    life[MID.Status2xx] = 40n;
    life[MID.Status4xx] = 2n;
    life[MID.StaticHits] = 8n;
    life[MID.WasmDispatches] = 34n;
    life[MID.GasUsed] = 1_000_000n;
    life[MID.DbOps] = 17n;
    life[MID.DbReads] = 12n;
    life[MID.DbWrites] = 5n;
    life[MID.StreamBytesIn] = 2048n;
    life[MID.StreamBytesOut] = 8192n;
    life[MID.MemGrownBytes] = 262144n;
    life[MID.CacheHits] = 900n;
    life[MID.CacheMisses] = 100n;
    return {
        life,
        connectedStreams: 3,
        committedMemory: 65536,
        reqMinuteUsed: 5,
        reqMinuteCap: 100,
        reqDayUsed: 42,
        reqDayCap: 5000,
        nowMs: 1_700_000_000_000,
    };
}

/**
 * Encode the v2 snapshot frame BYTE-FOR-BYTE like the edge (`analytics.rs` `encode_stats`), FIXED
 * layout (no strings):
 *   u16 version | u64 now_ms | u32 count | i64 × count | i64 connectedStreams | i64 committedMemory |
 *   i64 reqMinuteUsed | u64 reqMinuteCap | i64 reqDayUsed | u64 reqDayCap
 */
function encodeStats(s: DevTenantStats): Buffer {
    const head = Buffer.alloc(2 + 8 + 4);
    head.writeUInt16LE(FRAME_VERSION, 0);
    head.writeBigUInt64LE(BigInt(s.nowMs), 2);
    head.writeUInt32LE(s.life.length, 10);
    const body = Buffer.alloc(s.life.length * 8 + 48);
    let o = 0;
    for (const v of s.life) {
        body.writeBigInt64LE(v, o);
        o += 8;
    }
    body.writeBigInt64LE(BigInt(s.connectedStreams), o); o += 8;
    body.writeBigInt64LE(BigInt(s.committedMemory), o); o += 8;
    body.writeBigInt64LE(BigInt(s.reqMinuteUsed), o); o += 8;
    body.writeBigUInt64LE(BigInt(s.reqMinuteCap), o); o += 8;
    body.writeBigInt64LE(BigInt(s.reqDayUsed), o); o += 8;
    body.writeBigUInt64LE(BigInt(s.reqDayCap), o);
    return Buffer.concat([head, body]);
}

/** The metric ids carried in the per-minute ring (mirrors the edge `MINUTE_RING_METRICS`). Only these get
 *  minute resolution on the 1h/6h ranges; every other metric falls back to the hour ring there. */
const MINUTE_RING_METRICS = new Set<number>([0, 2, 1, 25, 26, 12, 13, 39, 43, 45]);

/**
 * Range id -> (bucketCount, bucketSecs), matching the edge `Range` + minute-ring fallback: 1h/6h are
 * per-minute ONLY for a minute-ring metric; otherwise they fall back to the hour ring (1h/6h buckets).
 */
function rangeShape(range: number, metricId: number): { count: number; bucketSecs: number } {
    const isMinute = (range === 0 || range === 1) && MINUTE_RING_METRICS.has(metricId);
    if (isMinute) return range === 0 ? { count: 60, bucketSecs: 60 } : { count: 360, bucketSecs: 60 };
    switch (range) {
        case 0: return { count: 1, bucketSecs: 3600 }; // 1h on the hour ring
        case 1: return { count: 6, bucketSecs: 3600 }; // 6h on the hour ring
        case 2: return { count: 12, bucketSecs: 3600 };
        case 3: return { count: 24, bucketSecs: 3600 };
        case 4: return { count: 72, bucketSecs: 3600 };
        case 5: return { count: 168, bucketSecs: 3600 };
        case 6: return { count: 336, bucketSecs: 3600 };
        case 7: return { count: 720, bucketSecs: 3600 };
        default: return { count: 24, bucketSecs: 3600 };
    }
}

/**
 * Encode the v2 series frame BYTE-FOR-BYTE like the edge `encode_series`:
 *   u16 version | u16 metricId | u32 bucketSecs | u64 headMs | u32 count | i64 × count
 * A synthetic gentle ramp so a dev dashboard draws a non-flat line.
 */
function encodeSeries(metricId: number, range: number): Buffer {
    const { count, bucketSecs } = rangeShape(range, metricId);
    const nowMs = 1_700_000_000_000;
    const head = Buffer.alloc(2 + 2 + 4 + 8 + 4);
    head.writeUInt16LE(FRAME_VERSION, 0);
    head.writeUInt16LE(metricId & 0xffff, 2);
    head.writeUInt32LE(bucketSecs, 4);
    head.writeBigUInt64LE(BigInt(nowMs), 8);
    head.writeUInt32LE(count, 16);
    const body = Buffer.alloc(count * 8);
    for (let i = 0; i < count; i++) {
        // A smooth ramp with a little variation, deterministic per (metric, index).
        const v = BigInt(((i * 7 + metricId) % 50) + i);
        body.writeBigInt64LE(v, i * 8);
    }
    return Buffer.concat([head, body]);
}

/**
 * Encode a site page BYTE-FOR-BYTE like the edge (analytics.rs `encode_site_list`):
 *   count u32 | (u32 nameLen, name bytes)* | has_more u8, all little-endian.
 */
function encodeSiteList(names: string[], hasMore: boolean): Buffer {
    const parts: Buffer[] = [];
    const head = Buffer.alloc(4);
    head.writeUInt32LE(names.length, 0);
    parts.push(head);
    for (const name of names) {
        const nb = Buffer.from(name, 'utf8');
        const nl = Buffer.alloc(4);
        nl.writeUInt32LE(nb.length, 0);
        parts.push(nl, nb);
    }
    parts.push(Buffer.from([hasMore ? 1 : 0]));
    return Buffer.concat(parts);
}

// Mirror the edge ABI bounds (analytics.rs) so dev exercises the SAME negative-status paths as prod.
const MAX_DOMAIN_LEN = 256;
const MAX_CURSOR_LEN = 256;
const ABSENT = -2; // the edge's ABSENT sentinel; the guest maps a negative status to empty stats/list.
// Pre-sorted so cursor pagination is deterministic and matches the edge's sorted enumeration.
const SITE_SAMPLE = ['demo.dacely.com', 'example.com', 'shop.test'];

/** The `env.analytics_read` + `env.analytics_list_sites` dev imports. Mirrors `buildDatabaseImports`. */
export function buildAnalyticsImports(
    ref: MemoryRef,
    db: DbDevState,
): Record<string, (...args: number[]) => number> {
    return {
        analytics_read: (domainPtr: number, domainLen: number): number => {
            // Over-long domain -> ABSENT, mirroring the edge (which returns a negative status, not a
            // trap); the guest maps it to empty stats. domainLen 0 = the caller's own stats.
            if (domainLen > MAX_DOMAIN_LEN) return ABSENT;
            if (domainLen > 0) {
                if (!ref.memory) throw new Error('analytics_read called before memory was bound');
                const m = Buffer.from(ref.memory.buffer);
                if (domainPtr < 0 || domainPtr + domainLen > m.length) {
                    throw new Error('analytics_read: domain out of bounds');
                }
            }
            const frame = encodeStats(devStats());
            db.lastResult = frame;
            db.lastResultVersion = -1;
            return frame.length;
        },

        // `env.analytics_series`: one metric's time-series for a range. Dev returns a synthetic ramp
        // (real ring reads are edge-side). Mirrors the edge bounds + negative-status paths.
        analytics_series: (
            domainPtr: number,
            domainLen: number,
            metricId: number,
            range: number,
        ): number => {
            if (domainLen > MAX_DOMAIN_LEN) return ABSENT;
            // Valid metric ids are 0..=46 (counters 0..=42 + the 4 gauge avg/peak series), ranges 0..=7.
            if (metricId < 0 || metricId > 46 || range < 0 || range > 7) return ABSENT;
            if (domainLen > 0) {
                if (!ref.memory) throw new Error('analytics_series called before memory was bound');
                const m = Buffer.from(ref.memory.buffer);
                if (domainPtr < 0 || domainPtr + domainLen > m.length) {
                    throw new Error('analytics_series: domain out of bounds');
                }
            }
            const frame = encodeSeries(metricId, range);
            db.lastResult = frame;
            db.lastResultVersion = -1;
            return frame.length;
        },

        // The dacely dashboard enumerate-all-sites stub. Dev returns a fixed SORTED sample for any
        // caller (the real dacely.com-only authz is the edge), but mirrors the edge ABI exactly:
        // over-long/non-utf8 cursor -> ABSENT, cursor = strictly-after, limit cap, and a REAL has_more.
        analytics_list_sites: (cursorPtr: number, cursorLen: number, limit: number): number => {
            if (cursorLen > MAX_CURSOR_LEN) return ABSENT;
            let cursor = '';
            if (cursorLen > 0) {
                if (!ref.memory) throw new Error('analytics_list_sites called before memory was bound');
                const m = Buffer.from(ref.memory.buffer);
                if (cursorPtr < 0 || cursorPtr + cursorLen > m.length) {
                    throw new Error('analytics_list_sites: cursor out of bounds');
                }
                const cb = m.subarray(cursorPtr, cursorPtr + cursorLen);
                try {
                    cursor = new TextDecoder('utf-8', { fatal: true }).decode(cb);
                } catch {
                    return ABSENT; // non-utf8 cursor -> empty page, mirroring the edge
                }
            }
            const start = SITE_SAMPLE.findIndex((n) => n > cursor); // strictly after the cursor
            const from = start < 0 ? SITE_SAMPLE.length : start;
            const lim = limit > 0 ? Math.min(limit, 256) : 256;
            const page = SITE_SAMPLE.slice(from, from + lim);
            const hasMore = from + page.length < SITE_SAMPLE.length;
            const frame = encodeSiteList(page, hasMore);
            db.lastResult = frame;
            db.lastResultVersion = -1;
            return frame.length;
        },
    };
}

/**
 * Dev-server analytics stub parity: the `env.analytics_read` / `env.analytics_series` dev imports must
 * encode the v2 frames BYTE-FOR-BYTE like the edge (`analytics.rs`), so a guest's toilscript `Analytics`
 * decode is identical in dev and prod. We decode the stashed frame positionally, exactly as the guest.
 */
import { describe, expect, it } from 'vitest';

import { buildAnalyticsImports } from '../src/devserver/analytics/index.js';

// Minimal fakes: domainLen 0 needs no memory; the stub stashes the frame into db.lastResult.
function harness() {
    const ref = { memory: null } as unknown as Parameters<typeof buildAnalyticsImports>[0];
    const db = { lastResult: null as Buffer | null, lastResultVersion: 0 } as unknown as Parameters<
        typeof buildAnalyticsImports
    >[1];
    return { imports: buildAnalyticsImports(ref, db), db };
}

describe('dev analytics stub v2 frame parity', () => {
    it('analytics_read encodes the fixed-layout snapshot frame', () => {
        const { imports, db } = harness();
        const n = imports.analytics_read(0, 0);
        const buf = db.lastResult as unknown as Buffer;
        expect(n).toBe(buf.length);

        let p = 0;
        const u16 = () => { const v = buf.readUInt16LE(p); p += 2; return v; };
        const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
        const u64 = () => { const v = buf.readBigUInt64LE(p); p += 8; return v; };
        const f64 = () => { const v = buf.readDoubleLE(p); p += 8; return v; };

        expect(u16()).toBe(2); // FRAME_VERSION
        u64(); // now_ms
        const count = u32();
        expect(count).toBe(42); // METRIC_COUNTERS (edge N_COUNTERS; no WasmDispatches)
        const life: bigint[] = [];
        for (let i = 0; i < count; i++) life.push(u64()); // counters are u64 LE now
        // Indices are the AUTHORITATIVE edge MetricId ids (metric_id.rs): a mislabel here means the dev
        // dashboard shows the wrong metric for every id past StaticHits.
        expect(life[0]).toBe(42n); // Requests (id 0)
        expect(life[1]).toBe(12345n); // BytesOutL1 (id 1)
        expect(life[11]).toBe(1_000_000n); // GasUsed (id 11, was 12 in the stale layout)
        expect(life[40]).toBe(900n); // CacheHits (id 40, was 41)
        expect(life[41]).toBe(100n); // CacheMisses (id 41, was 42)
        expect(u64()).toBe(3n); // connectedStreams
        expect(u64()).toBe(65536n); // committedMemory
        expect(u64()).toBe(5n); // reqMinuteUsed
        expect(u64()).toBe(100n); // reqMinuteCap
        expect(u64()).toBe(42n); // reqDayUsed
        expect(u64()).toBe(5000n); // reqDayCap
        // 7 LIVE per-second rates (f64 LE), appended after the windows.
        expect(f64()).toBeCloseTo(0.7); // rps
        expect(f64()).toBeCloseTo(68.2); // bytesInPerSec
        expect(f64()).toBeCloseTo(205.75); // bytesOutPerSec
        expect(f64()).toBeCloseTo(34.1); // streamBytesInPerSec
        expect(f64()).toBeCloseTo(136.5); // streamBytesOutPerSec
        expect(f64()).toBeCloseTo(0.28); // dbOpsPerSec
        expect(f64()).toBeCloseTo(16_666.67); // gasPerSec
        expect(p).toBe(buf.length); // no trailing bytes
    });

    it('analytics_series encodes the series frame with the right shape per range', () => {
        const { imports, db } = harness();
        // metric 0 (Requests), range 3 (H24) -> hour ring, 24 buckets, bucketSecs 3600.
        const n = imports.analytics_series(0, 0, 0, 3);
        const buf = db.lastResult as unknown as Buffer;
        expect(n).toBe(buf.length);
        let p = 0;
        expect(buf.readUInt16LE(p)).toBe(2); p += 2; // version
        expect(buf.readUInt16LE(p)).toBe(0); p += 2; // metric id
        expect(buf.readUInt32LE(p)).toBe(3600); p += 4; // bucketSecs
        p += 8; // headMs
        const count = buf.readUInt32LE(p); p += 4;
        expect(count).toBe(24);
        expect(buf.length).toBe(p + count * 8);

        // range 0 (1h) -> minute ring: 60 buckets, bucketSecs 60.
        imports.analytics_series(0, 0, 0, 0);
        const b2 = db.lastResult as unknown as Buffer;
        expect(b2.readUInt32LE(4)).toBe(60); // bucketSecs
        expect(b2.readUInt32LE(16)).toBe(60); // count

        // F1 guard: a minute-ring metric OTHER than Requests must ALSO get minute resolution on 1h.
        // GasUsed(11) is in the edge minute ring; a stale dev set fell back to the hour ring here.
        imports.analytics_series(0, 0, 11, 0); // GasUsed, 1h
        const bGas = db.lastResult as unknown as Buffer;
        expect(bGas.readUInt32LE(4)).toBe(60); // minute bucketSecs (was wrongly 3600 pre-fix)
        expect(bGas.readUInt32LE(16)).toBe(60); // 60 minute buckets (was wrongly 1)
        // A metric NOT in the minute ring (Status2xx=3) falls back to the hour ring on 1h.
        imports.analytics_series(0, 0, 3, 0);
        const bStat = db.lastResult as unknown as Buffer;
        expect(bStat.readUInt32LE(4)).toBe(3600); // hour bucketSecs
        expect(bStat.readUInt32LE(16)).toBe(1); // 1 hour bucket

        // range 8 (D60) + 9 (D90) -> DAY ring: 60/90 buckets, bucketSecs 86400.
        imports.analytics_series(0, 0, 0, 8);
        const b60 = db.lastResult as unknown as Buffer;
        expect(b60.readUInt32LE(4)).toBe(86_400); // bucketSecs
        expect(b60.readUInt32LE(16)).toBe(60); // count
        imports.analytics_series(0, 0, 0, 9);
        const b90 = db.lastResult as unknown as Buffer;
        expect(b90.readUInt32LE(4)).toBe(86_400); // bucketSecs
        expect(b90.readUInt32LE(16)).toBe(90); // count

        // A bad metric / range -> ABSENT (negative), no frame. Range 10 is past D90.
        expect(imports.analytics_series(0, 0, 999, 3)).toBeLessThan(0);
        expect(imports.analytics_series(0, 0, 0, 99)).toBeLessThan(0);
        expect(imports.analytics_series(0, 0, 0, 10)).toBeLessThan(0);
        // F2: valid ids are 0..=45 (gauges 42..=45); 46 is past the end and must be rejected like the edge.
        expect(imports.analytics_series(0, 0, 46, 3)).toBeLessThan(0);
        expect(imports.analytics_series(0, 0, 45, 3)).toBeGreaterThan(0); // gauge id 45 is valid
    });
});

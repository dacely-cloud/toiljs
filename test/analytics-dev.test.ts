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
        const i64 = () => { const v = buf.readBigInt64LE(p); p += 8; return v; };
        const u64 = () => { const v = buf.readBigUInt64LE(p); p += 8; return v; };

        expect(u16()).toBe(2); // FRAME_VERSION
        u64(); // now_ms
        const count = u32();
        expect(count).toBe(41); // METRIC_COUNTERS
        const life: bigint[] = [];
        for (let i = 0; i < count; i++) life.push(i64());
        expect(life[0]).toBe(42n); // Requests
        expect(life[1]).toBe(12345n); // BytesOutL1
        expect(life[12]).toBe(1_000_000n); // GasUsed
        expect(i64()).toBe(3n); // connectedStreams
        expect(i64()).toBe(65536n); // committedMemory
        expect(i64()).toBe(5n); // reqMinuteUsed
        expect(u64()).toBe(100n); // reqMinuteCap
        expect(i64()).toBe(42n); // reqDayUsed
        expect(u64()).toBe(5000n); // reqDayCap
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

        // A bad metric / range -> ABSENT (negative), no frame.
        expect(imports.analytics_series(0, 0, 999, 3)).toBeLessThan(0);
        expect(imports.analytics_series(0, 0, 0, 99)).toBeLessThan(0);
    });
});

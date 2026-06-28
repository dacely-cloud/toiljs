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

interface DevTenantStats {
    lifetime: [string, number][];
    reqMinuteUsed: number;
    reqMinuteCap: number;
    reqDayUsed: number;
    reqDayCap: number;
}

/** A plausible sample so a guest sees non-zero analytics under `toiljs dev`. */
function devStats(): DevTenantStats {
    return {
        lifetime: [
            ['requests', 42],
            ['bytes_served', 12345],
            ['status_2xx', 40],
            ['status_3xx', 0],
            ['status_4xx', 2],
            ['status_5xx', 0],
            ['static_hits', 8],
            ['wasm_dispatches', 34],
            ['db_ops', 17],
            ['db_reads', 12],
            ['db_writes', 5],
            ['db_errors', 0],
        ],
        reqMinuteUsed: 5,
        reqMinuteCap: 100,
        reqDayUsed: 42,
        reqDayCap: 5000,
    };
}

/**
 * Encode the versioned little-endian frame BYTE-FOR-BYTE like the edge encoder
 * (analytics.rs `encode_stats`) so the toilscript `DataReader` decode is identical
 * in dev and prod:
 *   u16 version | u32 count | (u32 nameLen, name bytes, i64 value)* |
 *   i64 reqMinuteUsed | u64 reqMinuteCap | i64 reqDayUsed | u64 reqDayCap
 */
function encodeStats(s: DevTenantStats): Buffer {
    const parts: Buffer[] = [];
    const head = Buffer.alloc(6);
    head.writeUInt16LE(1, 0); // frame version
    head.writeUInt32LE(s.lifetime.length, 2);
    parts.push(head);
    for (const [name, value] of s.lifetime) {
        const nb = Buffer.from(name, 'utf8');
        const nl = Buffer.alloc(4);
        nl.writeUInt32LE(nb.length, 0);
        const vb = Buffer.alloc(8);
        vb.writeBigInt64LE(BigInt(value), 0);
        parts.push(nl, nb, vb);
    }
    const tail = Buffer.alloc(32);
    tail.writeBigInt64LE(BigInt(s.reqMinuteUsed), 0);
    tail.writeBigUInt64LE(BigInt(s.reqMinuteCap), 8);
    tail.writeBigInt64LE(BigInt(s.reqDayUsed), 16);
    tail.writeBigUInt64LE(BigInt(s.reqDayCap), 24);
    parts.push(tail);
    return Buffer.concat(parts);
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

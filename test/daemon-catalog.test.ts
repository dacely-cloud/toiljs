/**
 * Unit tests for the daemon-side custom-section parsers and cron evaluator
 * (RECONCILIATION Part 5 byte layouts / F6 bitmask cron). These mirror the DB
 * catalog tests' style: hand-build the Part 5 bytes with `DataWriter`, wrap them
 * in a minimal wasm custom section, and assert the parser decodes them field-for-
 * field and fails CLOSED on a truncated/garbage section.
 */

import { describe, expect, it } from 'vitest';

import { DataWriter } from '../src/io/codec.js';
import { parseDaemonCatalog } from '../src/devserver/daemon/catalog.js';
import { cronMatches, cronNeverFires, nextCronFireMs } from '../src/devserver/daemon/cron.js';
import { customSection } from '../src/devserver/wasm/sections.js';
import { parseSurface } from '../src/devserver/wasm/surface.js';

/** Wrap a section payload (after the name) into a minimal one-section wasm module.
 *  Mirrors the DB catalog test's `wasmWithSection` helper. */
function wasmWithSection(name: string, payload: Uint8Array): Buffer {
    const nameBytes = Buffer.from(name);
    const sectionPayload = Buffer.concat([
        Buffer.from([nameBytes.length]),
        nameBytes,
        Buffer.from(payload),
    ]);
    return Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, sectionPayload.length]),
        sectionPayload,
    ]);
}

// --- toildaemon.catalog (Part 5) byte builders -----------------------------

interface BuildTask {
    name: string;
    taskIndex: number;
    kind: 0 | 1;
    intervalMs?: bigint;
    cron?: { minute: bigint; hour: number; dom: number; month: number; dow: number };
}

/** Emit a Part 5 `toildaemon.catalog` body (the bytes AFTER the section name). */
function buildDaemonCatalogBytes(hasDaemon: boolean, tasks: BuildTask[]): Uint8Array {
    const w = new DataWriter();
    w.writeU16(1); // format_version
    w.writeU8(hasDaemon ? 1 : 0);
    w.writeU16(tasks.length); // n_scheduled
    for (const t of tasks) {
        w.writeString(t.name);
        w.writeU16(t.taskIndex);
        w.writeU8(t.kind);
        w.writeU64(t.kind === 0 ? (t.intervalMs ?? 0n) : 0n); // interval_ms
        w.writeU64(t.cron?.minute ?? 0n); // cron_minute_mask
        w.writeU32(t.cron?.hour ?? 0); // cron_hour_mask
        w.writeU32(t.cron?.dom ?? 0); // cron_dom_mask
        w.writeU16(t.cron?.month ?? 0); // cron_month_mask
        w.writeU8(t.cron?.dow ?? 0); // cron_dow_mask
        w.writeU8(0); // overlap_policy
        w.writeU8(0); // catchup_policy
        w.writeU64(0n); // gas_hint
    }
    return w.toBytes();
}

describe('parseDaemonCatalog (Part 5)', () => {
    it('decodes an interval task and a cron task field-for-field', () => {
        // `0 */6 * * *`: minute 0; hours 0,6,12,18; dom 1..31; month 1..12; dow 0..6.
        const payload = buildDaemonCatalogBytes(true, [
            { name: 'tick', taskIndex: 0, kind: 0, intervalMs: 1000n },
            {
                name: 'sixHourly',
                taskIndex: 1,
                kind: 1,
                cron: {
                    minute: 1n, // bit 0 (minute 0)
                    hour: (1 << 0) | (1 << 6) | (1 << 12) | (1 << 18),
                    dom: 0xfffffffe, // bits 1..31
                    month: 0x1ffe, // bits 1..12
                    dow: 0x7f, // bits 0..6
                },
            },
        ]);
        const wasm = wasmWithSection('toildaemon.catalog', payload);
        const cat = parseDaemonCatalog(wasm);
        expect(cat).not.toBeNull();
        expect(cat!.hasDaemon).toBe(true);
        expect(cat!.tasks).toHaveLength(2);

        const [interval, cron] = cat!.tasks;
        expect(interval.name).toBe('tick');
        expect(interval.taskIndex).toBe(0);
        expect(interval.schedule).toEqual({ kind: 'interval', ms: 1000 });
        expect(interval.overlapPolicy).toBe(0);
        expect(interval.catchupPolicy).toBe(0);
        expect(interval.gasHint).toBe(0n);

        expect(cron.name).toBe('sixHourly');
        expect(cron.taskIndex).toBe(1);
        expect(cron.schedule.kind).toBe('cron');
        if (cron.schedule.kind === 'cron') {
            // The masks round-trip as BIT TESTS, never a string parse.
            const m = cron.schedule.masks;
            expect(m.minute).toBe(1n);
            expect((m.hour & (1 << 6)) !== 0).toBe(true);
            expect((m.hour & (1 << 7)) !== 0).toBe(false);
            expect(m.dom).toBe(0xfffffffe);
            expect(m.month).toBe(0x1ffe);
            expect(m.dow).toBe(0x7f);
        }
    });

    it('decodes a 60-bit minute mask without precision loss', () => {
        // minute 59 = bit 59, which is above 2^53 and must survive as a bigint.
        const minuteMask = 1n << 59n;
        const payload = buildDaemonCatalogBytes(true, [
            {
                name: 'lateMinute',
                taskIndex: 0,
                kind: 1,
                cron: { minute: minuteMask, hour: 0xffffff, dom: 0xfffffffe, month: 0x1ffe, dow: 0x7f },
            },
        ]);
        const cat = parseDaemonCatalog(wasmWithSection('toildaemon.catalog', payload));
        const t = cat!.tasks[0];
        expect(t.schedule.kind === 'cron' && t.schedule.masks.minute).toBe(minuteMask);
    });

    it('returns null for an absent section (no daemon -> emulator stays off)', () => {
        const wasm = wasmWithSection('toildb.catalog', Buffer.from([0x01, 0x00]));
        expect(parseDaemonCatalog(wasm)).toBeNull();
    });

    it('fails closed: a truncated record yields only the cleanly-decoded prefix', () => {
        // Claim 2 tasks but truncate inside the second record's interval_ms.
        const full = buildDaemonCatalogBytes(true, [
            { name: 'a', taskIndex: 0, kind: 0, intervalMs: 5000n },
            { name: 'b', taskIndex: 1, kind: 0, intervalMs: 9000n },
        ]);
        const truncated = full.subarray(0, full.length - 20); // chop the 2nd record's tail
        const cat = parseDaemonCatalog(wasmWithSection('toildaemon.catalog', truncated));
        expect(cat).not.toBeNull();
        // Only the first task survived; the loop stopped on the short read.
        expect(cat!.tasks.map((t) => t.name)).toEqual(['a']);
    });

    it('returns null for a wholly garbage section (header short-read, no daemon)', () => {
        const cat = parseDaemonCatalog(wasmWithSection('toildaemon.catalog', Buffer.from([0x01])));
        expect(cat).toBeNull();
    });
});

// --- toil.surface (Part 5) -------------------------------------------------

function buildSurfaceBytes(opts: {
    mode: 0 | 1;
    flags: number;
    abi?: number;
    buildId?: string;
}): Uint8Array {
    const w = new DataWriter();
    w.writeU16(1); // format_version
    w.writeU8(opts.mode); // target_mode
    w.writeU8(0); // reserved0
    w.writeU32(opts.flags); // surface_flags
    w.writeU16(opts.abi ?? 1); // abi_version
    w.writeString(opts.buildId ?? ''); // build_id
    w.writeU32(0xdeadbeef); // fingerprint
    w.writeU32(0x11111111); // data_coherence_hash
    w.writeU32(0x22222222); // pair_coherence_hash (exactly THREE u32 after build_id)
    return w.toBytes();
}

describe('parseSurface (Part 5)', () => {
    it('decodes a cold daemon surface with exactly three trailing u32 hashes', () => {
        const flags = 0b000100 | 0b001000; // daemon (bit2) + scheduled (bit3)
        const s = parseSurface(wasmWithSection('toil.surface', buildSurfaceBytes({ mode: 1, flags })));
        expect(s).not.toBe('absent');
        expect(s).not.toBe('invalid');
        if (s !== 'absent' && s !== 'invalid') {
            expect(s.targetMode).toBe('cold');
            expect(s.flags.daemon).toBe(true);
            expect(s.flags.scheduled).toBe(true);
            expect(s.flags.rest).toBe(false);
            expect(s.fingerprint).toBe(0xdeadbeef);
            expect(s.dataCoherenceHash).toBe(0x11111111);
            expect(s.pairCoherenceHash).toBe(0x22222222);
        }
    });

    it('decodes a hot surface (target_mode 0)', () => {
        const s = parseSurface(wasmWithSection('toil.surface', buildSurfaceBytes({ mode: 0, flags: 1 })));
        expect(s !== 'absent' && s !== 'invalid' && s.targetMode).toBe('hot');
    });

    it("treats an ABSENT section as 'absent' (legacy single artifact, load as hot)", () => {
        const wasm = wasmWithSection('toildb.catalog', Buffer.from([0x01, 0x00]));
        expect(parseSurface(wasm)).toBe('absent');
    });

    it("fails closed: a PRESENT but truncated section is 'invalid'", () => {
        const full = buildSurfaceBytes({ mode: 1, flags: 4 });
        const truncated = full.subarray(0, full.length - 3); // chop a trailing hash
        expect(parseSurface(wasmWithSection('toil.surface', truncated))).toBe('invalid');
    });
});

describe('customSection bounds-checking', () => {
    it('returns null for a non-wasm buffer', () => {
        expect(customSection(Buffer.from('not a wasm module at all'), 'toil.surface')).toBeNull();
    });

    it('returns null for a truncated section table (no over-read)', () => {
        // Magic + version, then a custom-section id with a length that runs past the end.
        const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x7f]);
        expect(customSection(wasm, 'toil.surface')).toBeNull();
    });
});

describe('cron bitmask evaluation (F6, never a string parse)', () => {
    // `0 */6 * * *`: minute 0; hours 0,6,12,18; every dom/month/dow.
    const sixHourly = {
        minute: 1n, // bit 0
        hour: (1 << 0) | (1 << 6) | (1 << 12) | (1 << 18),
        dom: 0xfffffffe,
        month: 0x1ffe,
        dow: 0x7f,
    };

    it('matches the right minute/hour and rejects others', () => {
        expect(cronMatches(sixHourly, new Date(2026, 5, 22, 6, 0, 0))).toBe(true);
        expect(cronMatches(sixHourly, new Date(2026, 5, 22, 12, 0, 0))).toBe(true);
        expect(cronMatches(sixHourly, new Date(2026, 5, 22, 6, 1, 0))).toBe(false); // wrong minute
        expect(cronMatches(sixHourly, new Date(2026, 5, 22, 7, 0, 0))).toBe(false); // wrong hour
    });

    it('computes the next fire time by walking forward minute by minute', () => {
        const from = new Date(2026, 5, 22, 6, 1, 0).getTime();
        const next = nextCronFireMs(sixHourly, from);
        expect(next).not.toBeNull();
        expect(new Date(next!).getHours()).toBe(12);
        expect(new Date(next!).getMinutes()).toBe(0);
    });

    it('honors the dom/dow union rule', () => {
        // Fire on the 1st of the month OR on Sunday (both restricted -> union).
        const masks = {
            minute: 1n, // minute 0
            hour: 1, // hour 0
            dom: 1 << 1, // only day-of-month 1
            month: 0x1ffe, // every month
            dow: 1 << 0, // only Sunday
        };
        // 2026-06-01 is a Monday -> matches via dom (the 1st).
        expect(cronMatches(masks, new Date(2026, 5, 1, 0, 0, 0))).toBe(true);
        // 2026-06-07 is a Sunday -> matches via dow.
        expect(cronMatches(masks, new Date(2026, 5, 7, 0, 0, 0))).toBe(true);
        // 2026-06-03 is a Wednesday, not the 1st -> no match.
        expect(cronMatches(masks, new Date(2026, 5, 3, 0, 0, 0))).toBe(false);
    });

    it('flags an all-zero (unsatisfiable) mask as never-firing', () => {
        expect(cronNeverFires({ minute: 0n, hour: 0, dom: 0, month: 0, dow: 0 })).toBe(true);
        expect(cronNeverFires(sixHourly)).toBe(false);
    });
});

/**
 * Parse a compiled COLD server wasm's `toildaemon.catalog` custom section into the
 * dev daemon scheduler's task list. Emitted by the toilscript cold pass
 * (`buildToilDaemonCatalog`) into `release-cold.wasm` when a `@daemon` class
 * exists. Cron schedules are PRECOMPUTED BITMASKS (RECONCILIATION F6): the reader
 * does bit tests, NEVER a runtime cron-string parse.
 *
 * Byte layout (RECONCILIATION Part 5, all little-endian; mirrors the toilscript
 * `CatWriter` emitter byte-for-byte):
 *
 *   u16 format_version = 1, 2, or 3
 *   u8  has_daemon
 *   u8 startup_kind             (v3 only: 1 Action, 2 Job; older versions Action)
 *   u16 n_scheduled
 *   per task:
 *     str name                  (u32 len + UTF-8)
 *     u16 task_index            (the scheduled_tick(task_id) argument)
 *     u8  schedule_kind         (0 = interval, 1 = cron)
 *     u64 interval_ms           (used when schedule_kind = 0, else 0)
 *     u64 cron_minute_mask      (bits 0..59)
 *     u32 cron_hour_mask        (bits 0..23)
 *     u32 cron_dom_mask         (bits 1..31)
 *     u16 cron_month_mask       (bits 1..12)
 *     u8  cron_dow_mask         (bits 0..6)
 *     u8  overlap_policy        (0 = skip-if-running)
 *     u8  catchup_policy        (0 = no-backfill)
 *     u64 gas_hint
 *     u8 function_kind          (v2/v3: 1 Action, 2 Job; v1 is Action)
 *
 * Fails closed via `DataReader.ok`: a short read rejects the whole catalog.
 * An absent or unparseable section returns `null`, so the daemon emulator does not start
 * (fail-closed = never run an unknown daemon).
 */

import { DataReader } from 'toiljs/io';

import { DbFunctionKind } from '../db/types.js';
import { customSection } from '../wasm/sections.js';

/** The five precomputed cron field bitmasks (RECONCILIATION Part 5 / F6). */
export interface CronMasks {
    /** u64, bits 0..59 (one per minute). */
    readonly minute: bigint;
    /** u32, bits 0..23 (one per hour). */
    readonly hour: number;
    /** u32, bits 1..31 (one per day-of-month). */
    readonly dom: number;
    /** u16, bits 1..12 (one per month). */
    readonly month: number;
    /** u8, bits 0..6 (one per day-of-week, 0 = Sunday). */
    readonly dow: number;
}

/** One `@scheduled` task the dev scheduler drives. */
export interface ScheduledTask {
    readonly name: string;
    /** The `scheduled_tick(task_id)` argument; equals declaration order. */
    readonly taskIndex: number;
    readonly schedule:
        | { readonly kind: 'interval'; readonly ms: number }
        | { readonly kind: 'cron'; readonly masks: CronMasks };
    /** 0 = skip-if-running (the at-most-once default). */
    readonly overlapPolicy: number;
    /** 0 = no-backfill (the at-most-once default). */
    readonly catchupPolicy: number;
    readonly gasHint: bigint;
    /** The host execution kind, validated before any task starts. */
    readonly functionKind: DbFunctionKind.Action | DbFunctionKind.Job;
}

export interface DaemonCatalog {
    readonly hasDaemon: boolean;
    readonly startupKind: DbFunctionKind.Action | DbFunctionKind.Job;
    readonly tasks: readonly ScheduledTask[];
}

export function parseDaemonCatalog(wasm: Buffer): DaemonCatalog | null {
    let sec: Buffer | null;
    try {
        sec = customSection(wasm, 'toildaemon.catalog');
    } catch {
        return null; // garbage section table (mid-rebuild) -> no daemon
    }
    if (sec === null || sec.length > 64 * 1024) return null;

    const r = new DataReader(sec);
    const version = r.readU16();
    if (version !== 1 && version !== 2 && version !== 3) return null;
    const hasDaemon = r.readU8() === 1;
    const startupByte = version === 3 ? r.readU8() : 1;
    if (startupByte !== 1 && startupByte !== 2) return null;
    const startupKind = startupByte === 2 ? DbFunctionKind.Job : DbFunctionKind.Action;
    const n = r.readU16(); // n_scheduled
    // The 5-byte header must read cleanly; a short read here is a garbage section
    // (fail closed -> no daemon). A `hasDaemon` byte salvaged from a too-short
    // version field is not trustworthy.
    if (!r.ok || n > 4096) return null;
    const tasks: ScheduledTask[] = [];
    for (let i = 0; i < n && r.ok; i++) {
        const name = r.readString();
        const taskIndex = r.readU16();
        const kind = r.readU8(); // schedule_kind: 0 = interval, 1 = cron
        const intervalMs = r.readU64(); // bigint; 0 when kind = 1
        const minute = r.readU64(); // cron_minute_mask (bits 0..59)
        const hour = r.readU32(); // cron_hour_mask
        const dom = r.readU32(); // cron_dom_mask
        const month = r.readU16(); // cron_month_mask
        const dow = r.readU8(); // cron_dow_mask
        const overlapPolicy = r.readU8();
        const catchupPolicy = r.readU8();
        const gasHint = r.readU64();
        const functionKindByte = version >= 2 ? r.readU8() : 1;
        if (
            !r.ok ||
            taskIndex !== i ||
            Buffer.byteLength(name) > 1024 ||
            (functionKindByte !== 1 && functionKindByte !== 2)
        )
            return null;
        const functionKind = functionKindByte === 2 ? DbFunctionKind.Job : DbFunctionKind.Action;
        if (r.ok)
            tasks.push({
                name,
                taskIndex,
                schedule:
                    kind === 1
                        ? { kind: 'cron', masks: { minute, hour, dom, month, dow } }
                        : { kind: 'interval', ms: Number(intervalMs) },
                overlapPolicy,
                catchupPolicy,
                gasHint,
                functionKind,
            });
    }
    if (!r.ok || r.remaining() !== 0) return null;
    return { hasDaemon, startupKind, tasks };
}

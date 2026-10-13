import { DbFunctionKind, type DbDevState } from './types.js';

type Imports = Record<string, (...args: number[]) => number | bigint>;
const counters = new WeakMap<
    DbDevState,
    { kind: DbFunctionKind; ops: number; writes: number; bytes: number }
>();
const exempt = new Set([
    'data.resolve_collection',
    'data.take_result',
    'data.result_schema_version',
    'data.write_allowed',
]);
const reads = new Set([
    'data.get',
    'data.get_current',
    'data.get_many',
    'data.exists',
    'data.unique_lookup',
    'data.view_get',
    'data.membership_contains',
    'data.membership_list',
    'data.membership_page',
    'data.counter_get',
    'data.events_get',
    'data.events_reference',
    'data.events_entries',
    'data.events_last',
    'data.latest',
    'data.events_since',
    'data.capacity_available',
]);
const results = new Set([
    'data.get',
    'data.get_current',
    'data.get_many',
    'data.get_delete',
    'data.patch',
    'data.unique_lookup',
    'data.view_get',
    'data.membership_list',
    'data.membership_page',
    'data.counter_get',
    'data.events_get',
    'data.events_reference',
    'data.events_entries',
    'data.events_last',
    'data.latest',
    'data.events_since',
    'data.capacity_available',
    'data.capacity_reserve',
]);
const writeLength: Record<string, number> = {
    'data.create': 4,
    'data.patch': 4,
    'data.upsert': 4,
    'data.enqueue': 4,
    'data.compare_exchange': 6,
    'data.compare_delete': 4,
    'data.unique_claim': 4,
    'data.view_publish': 4,
    'data.membership_add': 4,
    'data.append': 4,
    'data.append_once': 6,
};

export function resetDbLimits(db: DbDevState): void {
    counters.delete(db);
}

export function checkDbResultSize(db: DbDevState, bytes: number): void {
    if (process.env.TOIL_DEV_CHECK_DB_LIMITS !== '1') return;
    const max =
        db.functionKind === DbFunctionKind.Query
            ? 65536
            : db.functionKind === DbFunctionKind.Action
              ? 131072
              : 1048576;
    if (bytes > max)
        throw new Error(
            `TDL021: ${db.functionKind} DB operation uses ${String(bytes)} bytes; maximum is ${String(max)}`,
        );
}

/** Opt-in checks against the native host's default operation and byte budgets. */
export function withDbLimits(imports: Imports, db: DbDevState): Imports {
    return Object.fromEntries(
        Object.entries(imports).map(([name, operation]) => [
            name,
            (...args: number[]): number | bigint => {
                if (process.env.TOIL_DEV_CHECK_DB_LIMITS !== '1' || exempt.has(name))
                    return operation(...args);
                const kind = db.functionKind;
                let count = counters.get(db);
                if (count === undefined || count.kind !== kind) {
                    count = { kind, ops: 0, writes: 0, bytes: 0 };
                    counters.set(db, count);
                }
                const maxOps =
                    kind === DbFunctionKind.Query || kind === DbFunctionKind.Action ? 64 : 65535;
                const maxWrites =
                    kind === DbFunctionKind.Query ? 0 : kind === DbFunctionKind.Action ? 32 : 65535;
                const maxBytes =
                    kind === DbFunctionKind.Query
                        ? 131072
                        : kind === DbFunctionKind.Action
                          ? 2097152
                          : 16777216;
                const writing = !reads.has(name);
                if (++count.ops > maxOps || (writing && ++count.writes > maxWrites))
                    throw new Error(
                        `TDL020: ${name} exceeds ${kind} DB budget (${String(count.ops)}/${String(maxOps)} operations, ${String(count.writes)}/${String(maxWrites)} writes)`,
                    );
                const writeBytes =
                    (name === 'data.events_redact' ? 16 : writeLength[name] === undefined ? 0 : args[writeLength[name]]) +
                    (name === 'data.compare_exchange' ? Math.max(0, args[4]) : 0);
                checkDbResultSize(db, writeBytes);
                if (count.bytes + writeBytes > maxBytes)
                    throw new Error(
                        `TDL021: ${kind} cumulative DB byte budget exceeds ${String(maxBytes)}`,
                    );
                count.bytes += writeBytes;
                const status = operation(...args);
                if (typeof status === 'number' && status >= 0) {
                    const bytes = results.has(name)
                        ? (db.lastResult?.length ?? 0)
                        : name === 'data.unique_claim' && status === 1
                          ? (db.lastResult?.length ?? 0)
                          : 0;
                    checkDbResultSize(db, bytes);
                    if (count.bytes + bytes > maxBytes)
                        throw new Error(
                            `TDL021: ${kind} cumulative DB byte budget exceeds ${String(maxBytes)}`,
                        );
                    count.bytes += bytes;
                }
                return status;
            },
        ]),
    );
}

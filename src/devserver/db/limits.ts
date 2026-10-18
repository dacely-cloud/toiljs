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
    'data.job_allowed',
    'data.atomic_batch',
    'data.budget',
    'data.changes',
    'data.begin_derive',
    'data.end_derive',
    'data.continue_derive',
]);
const reads = new Set([
    'data.atomic_get',
    'data.get',
    'data.get_current',
    'data.get_many',
    'data.exists',
    'data.unique_lookup',
    'data.view_get',
    'data.membership_contains',
    'data.membership_list',
    'data.membership_page',
    'data.documents_scan',
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
    'data.atomic_get',
    'data.get',
    'data.get_current',
    'data.get_many',
    'data.get_delete',
    'data.patch',
    'data.unique_lookup',
    'data.view_get',
    'data.membership_list',
    'data.membership_page',
    'data.documents_scan',
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

/** The current dispatch's native-default DB budget and consumed resources. */
export interface DbBudgetSnapshot {
    ops: number;
    writes: number;
    bytes: number;
    maxOps: number;
    maxWrites: number;
    maxBytes: number;
    maxResultBytes: number;
    remainingOps: number;
    remainingWrites: number;
    remainingBytes: number;
}

export function dbBudgetSnapshot(db: DbDevState): DbBudgetSnapshot {
    const kind = db.budgetKind ?? db.functionKind;
    const count = counters.get(db);
    const ops = count?.kind === kind ? count.ops : 0;
    const writes = count?.kind === kind ? count.writes : 0;
    const bytes = count?.kind === kind ? count.bytes : 0;
    const maxOps = kind === DbFunctionKind.Query || kind === DbFunctionKind.Action ? 64 : 65535;
    const maxWrites =
        kind === DbFunctionKind.Query ? 0 : kind === DbFunctionKind.Action ? 32 : 65535;
    const maxBytes =
        kind === DbFunctionKind.Query
            ? 131072
            : kind === DbFunctionKind.Action
              ? 2097152
              : 16777216;
    const maxResultBytes =
        kind === DbFunctionKind.Query ? 65536 : kind === DbFunctionKind.Action ? 131072 : 1048576;
    return {
        ops,
        writes,
        bytes,
        maxOps,
        maxWrites,
        maxBytes,
        maxResultBytes,
        remainingOps: Math.max(0, maxOps - ops),
        remainingWrites: Math.max(0, maxWrites - writes),
        remainingBytes: Math.max(0, maxBytes - bytes),
    };
}

export function formatDbBudget(db: DbDevState): string {
    const b = dbBudgetSnapshot(db);
    return `${db.functionKind}: ops=${b.ops}/${b.maxOps} writes=${b.writes}/${b.maxWrites} bytes=${b.bytes}/${b.maxBytes}; remaining ops=${b.remainingOps} writes=${b.remainingWrites} bytes=${b.remainingBytes}`;
}

export function resetDbLimits(db: DbDevState): void {
    counters.delete(db);
}

/** Additional bounded storage probes within a document scan. */
export function chargeDbReadProbe(db: DbDevState): void {
    const kind = db.budgetKind ?? db.functionKind;
    let count = counters.get(db);
    if (count === undefined || count.kind !== kind) {
        count = { kind, ops: 0, writes: 0, bytes: 0 };
        counters.set(db, count);
    }
    if (process.env.TOIL_DEV_CHECK_DB_LIMITS === '1' && count.ops + 1 > dbBudgetSnapshot(db).maxOps)
        throw new Error('TDL020: document scan exceeds operation budget');
    count.ops++;
}

/** A durable scheduler request is one write operation plus its control-row bytes. */
export function chargeDbControlWrite(
    db: DbDevState,
    bytes: number,
    operation = 'data.continue_derive',
): void {
    const kind = db.budgetKind ?? db.functionKind;
    let count = counters.get(db);
    if (count === undefined || count.kind !== kind) {
        count = { kind, ops: 0, writes: 0, bytes: 0 };
        counters.set(db, count);
    }
    const limits = dbBudgetSnapshot(db);
    const enforcing = process.env.TOIL_DEV_CHECK_DB_LIMITS === '1';
    if (enforcing && (count.ops + 1 > limits.maxOps || count.writes + 1 > limits.maxWrites))
        throw new Error(`TDL020: ${operation} exceeds DB budget; ${formatDbBudget(db)}`);
    count.ops++;
    count.writes++;
    checkDbResultSize(db, bytes);
    if (enforcing && count.bytes + bytes > limits.maxBytes)
        throw new Error(`TDL021: ${operation} exceeds DB byte budget; ${formatDbBudget(db)}`);
    count.bytes += bytes;
    if (process.env.TOIL_DEV_TRACE_DB_LIMITS === '1')
        console.error(`[toil db] ${operation} ${formatDbBudget(db)}`);
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
                if (exempt.has(name)) return operation(...args);
                const kind = db.budgetKind ?? db.functionKind;
                let count = counters.get(db);
                if (count === undefined || count.kind !== kind) {
                    count = { kind, ops: 0, writes: 0, bytes: 0 };
                    counters.set(db, count);
                }
                const enforcing = process.env.TOIL_DEV_CHECK_DB_LIMITS === '1';
                const { maxOps, maxWrites, maxBytes } = dbBudgetSnapshot(db);
                const writing = !reads.has(name);
                const nextOps = count.ops + 1;
                const nextWrites = count.writes + (writing ? 1 : 0);
                if (enforcing && (nextOps > maxOps || nextWrites > maxWrites))
                    throw new Error(
                        `TDL020: ${name} exceeds DB budget (${nextOps}/${maxOps} operations, ${nextWrites}/${maxWrites} writes; ${formatDbBudget(db)})`,
                    );
                const writeBytes =
                    (name === 'data.events_redact'
                        ? 16
                        : writeLength[name] === undefined
                          ? 0
                          : args[writeLength[name]]) +
                    (name === 'data.compare_exchange' ? Math.max(0, args[4]) : 0);
                checkDbResultSize(db, writeBytes);
                if (enforcing && count.bytes + writeBytes > maxBytes)
                    throw new Error(
                        `TDL021: ${kind} cumulative DB byte budget exceeds ${String(maxBytes)}`,
                    );
                count.ops = nextOps;
                count.writes = nextWrites;
                count.bytes += writeBytes;
                const status = operation(...args);
                if (typeof status === 'number' && status >= 0) {
                    const bytes = results.has(name)
                        ? (db.lastResult?.length ?? 0)
                        : name === 'data.unique_claim' && status === 1
                          ? (db.lastResult?.length ?? 0)
                          : 0;
                    checkDbResultSize(db, bytes);
                    if (enforcing && count.bytes + bytes > maxBytes)
                        throw new Error(
                            `TDL021: ${kind} cumulative DB byte budget exceeds ${String(maxBytes)}`,
                        );
                    count.bytes += bytes;
                }
                if (process.env.TOIL_DEV_TRACE_DB_LIMITS === '1')
                    console.info(`[toil db] ${name}: ${formatDbBudget(db)}`);
                return status;
            },
        ]),
    );
}

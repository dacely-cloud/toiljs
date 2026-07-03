/**
 * Shared types, limits, and ABI return codes for the dev ToilDB emulation
 * (see `./database.ts`). The wire ABI mirrors the production edge byte-for-byte
 * (toildb/ABI.md): every byte region is a (ptr,len) into guest memory; returns
 * are `>= 0` success (a length/handle/flag), `-1` too-small, `-2` absent,
 * `<= -1000` a typed error (`-(1000+TDLnnn)`).
 */

export enum CollectionFamily {
    Record = 0,
    View = 1,
    Events = 2,
    Counter = 3,
    Membership = 4,
    Unique = 5,
    Capacity = 6,
}

export enum DbFunctionKind {
    Query = 'query',
    Action = 'action',
    Derive = 'derive',
    Job = 'job',
    Admin = 'admin',
}

export function isCollectionFamily(value: number): value is CollectionFamily {
    return value >= CollectionFamily.Record && value <= CollectionFamily.Capacity;
}

export interface DevCollectionHandle {
    name: string;
    family: CollectionFamily;
    schemaVersion: number;
    replication: number;
    placement: number;
    fillMaxWaitMs: number;
    fillAllowStale: boolean;
}

export type DbCatalogState =
    | { kind: 'no-section' }
    | { kind: 'malformed' }
    | { kind: 'present'; collections: Map<string, DevCollectionHandle> };

/** Per-request data state: resolved handles + the last variable-length result +
 *  the schema_version of that result's row (surfaced via result_schema_version). */
export interface DbDevState {
    handles: DevCollectionHandle[];
    lastResult: Buffer | null;
    lastResultVersion: number;
    functionKind: DbFunctionKind;
    /** Names ("Db/coll") of source collections written during this dispatch, so
     *  the runtime can re-run the affected `@derive` materializers afterward.
     *  Only populated for non-Derive dispatches (a derive's own writes must not
     *  re-trigger it - see `database.ts` `recordWrite`). */
    writtenCollections: Set<string>;
    /** The derive index currently running (set by `runDerive`), so `events.since` keys its resumable
     *  checkpoint per (derive, source key). 0 outside a derive. */
    deriveId: number;
}

export function freshDbState(): DbDevState {
    return {
        handles: [],
        lastResult: null,
        lastResultVersion: -1,
        functionKind: DbFunctionKind.Job,
        writtenCollections: new Set<string>(),
        deriveId: 0,
    };
}

/** A finite-resource escrow: a ceiling + a set of reservations, each held (in
 *  flight, TTL'd) or confirmed (a permanent consume). Both count against available;
 *  a confirmed reservation never expires. Mirrors `toildb::capacity::Escrow`. */
export interface Reservation {
    amount: bigint;
    expiresMs: number;
    confirmed: boolean;
}
export interface CapLedger {
    total: bigint;
    reservations: Map<bigint, Reservation>;
    nextId: bigint;
}

/** The on-disk snapshot shape: dev data + its versions, JSON with base64 buffers. */
export interface DbSnapshot {
    store: Record<string, { v: string; sv: number }>; // records + unique owners (+ schema_version)
    recordIdem?: Record<
        string,
        { requestHash: string; state: 'pending' | 'done'; outcome?: RecordOutcomeSnapshot }
    >;
    uniqueIdem?: Record<string, string>;
    views: Record<string, { v: string; sv: number }>;
    members: Record<string, Record<string, { v: string; sv: number }>>;
    counters: Record<string, string>;
    counterIdem?: Record<string, string>;
    events: Record<string, { v: string; sv: number }[]>;
    eventDedup: Record<string, string[]>;
    capacity: Record<
        string,
        {
            total: string;
            nextId: string;
            reservations: [string, { amount: string; expiresMs: number; confirmed: boolean }][];
        }
    >;
}

export type RecordOutcomeSnapshot =
    | { kind: 'unit' }
    | { kind: 'value'; v: string; sv: number }
    | { kind: 'absent' }
    | { kind: 'already_exists' }
    | { kind: 'not_found' }
    | { kind: 'conflict' };

/** Edge caps (toildb::capacity::escrow): bound the reservation count + the hold TTL. */
export const MAX_RESERVATIONS = 4096;
export const MAX_RESERVATION_TTL_MS = 86_400_000; // 24h

export const MAX_NAME = 512;
export const MAX_KEY = 4096;
export const MAX_VALUE = 256 * 1024;
export const DEFAULT_FILL_WAIT_MS = 50;
export const MAX_FILL_WAIT_MS = 60_000;

// i64 saturation bounds (the edge `MemEngine`/`ScyllaEngine` counters are i64).
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
export function satI64(v: bigint): bigint {
    return v < I64_MIN ? I64_MIN : v > I64_MAX ? I64_MAX : v;
}

// Return codes, mirroring the edge ABI (`toildb::observe::diagnostics`): a typed
// error is `-(1000 + TDLnnn)`; a plain absence is ABSENT (-2), not a typed error.
export const ABSENT = -2; // NotFound / absent
export const TOO_SMALL = -1;
export const INVALID_HANDLE = -1001; // TDL001
export const ALREADY_EXISTS = -1003; // TDL003 (create on an existing key)
export const CONFLICT = -1004; // TDL004 (e.g. unique release by a non-owner)
export const UNAVAILABLE = -1031; // TDL031 (retryable in-flight/uncertain op)
export const CODEC_ERR = -1006; // TDL006 (e.g. a non-positive reserve amount)
export const OP_NOT_ALLOWED_FOR_FAMILY = -1010; // TDL010
export const OP_NOT_ALLOWED_IN_KIND = -1011; // TDL011
export const TOO_MANY_KEYS = -1020; // TDL020 (get_many over the per-call cap)
export const SCHEMA_UNAVAILABLE = -1070; // TDL070

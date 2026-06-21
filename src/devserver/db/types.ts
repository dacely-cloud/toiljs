/**
 * Shared types, limits, and ABI return codes for the dev ToilDB emulation
 * (see `./database.ts`). The wire ABI mirrors the production edge byte-for-byte
 * (toildb/ABI.md): every byte region is a (ptr,len) into guest memory; returns
 * are `>= 0` success (a length/handle/flag), `-1` too-small, `-2` absent,
 * `<= -1000` a typed error (`-(1000+TDLnnn)`).
 */

/** Per-request data state: resolved handles + the last variable-length result +
 *  the schema_version of that result's row (surfaced via result_schema_version). */
export interface DbDevState {
    handles: string[];
    lastResult: Buffer | null;
    lastResultVersion: number;
}

export function freshDbState(): DbDevState {
    return { handles: [], lastResult: null, lastResultVersion: -1 };
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
    views: Record<string, { v: string; sv: number }>;
    members: Record<string, Record<string, { v: string; sv: number }>>;
    counters: Record<string, string>;
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

/** Edge caps (toildb::capacity::escrow): bound the reservation count + the hold TTL. */
export const MAX_RESERVATIONS = 4096;
export const MAX_RESERVATION_TTL_MS = 86_400_000; // 24h

export const MAX_NAME = 512;
export const MAX_KEY = 4096;
export const MAX_VALUE = 256 * 1024;

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
export const CODEC_ERR = -1006; // TDL006 (e.g. a non-positive reserve amount)
export const TOO_MANY_KEYS = -1020; // TDL020 (get_many over the per-call cap)

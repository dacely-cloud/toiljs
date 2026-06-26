/**
 * Host-import surface for the dev daemon (cold) box, mirroring the production
 * edge's `daemon.*` imports. DAEMON path only (streams are Phase 4).
 *
 * Per RECONCILIATION:
 *   - Part 4 `daemon.*`: is_leader / current_epoch / yield / sleep_ms / task_count
 *     / next_fire_ms / http_call. In a single dev process the leader
 *     stub is always true and the lease never expires (section 5.2). Fenced DB
 *     writes are TRANSPARENT (no `daemon.db_write_fenced` import).
 *   - Part 3 error bridge: a u16 subsystem code `c` is returned as `-(0x10000 + c)`;
 *     the buffer sentinels `-1` (TOO_SMALL) / `-2` (ABSENT) are unchanged.
 *
 * The cold box also imports the request-surface `env.*` MINUS the response/stream
 * functions it must not have (no `set_status`/`set_header`/`respond_file`/
 * `client_ip`/`ratelimit_check`); it keeps `@data`/crypto/env/`Date.now`/email so a
 * daemon can read+write the DB and send mail. The two allow-lists live in
 * `runtime/module.ts`.
 */

import { buildDatabaseImports, type DbDevState, freshDbState } from '../db/index.js';
import { buildCryptoImports, type CryptoState, freshCryptoState } from '../runtime/crypto.js';
import { buildEnvImports, type MemoryRef } from '../runtime/host.js';

/**
 * Resolved daemon (L4) config the dev scheduler reads. Structurally identical to
 * the compiler's `ResolvedDaemonConfig`; declared here so the devserver package has
 * no source dependency on the compiler package (its tsconfig is isolated to
 * `src/devserver`). The compiler's resolved config is passed in verbatim.
 */
export interface ResolvedDaemonConfig {
    readonly region: string | null;
    readonly standbyRegion: string | null;
    readonly defaultIntervalMs: number;
    readonly tickBudgetMs: number;
    readonly gasTick: number;
    readonly maxTasks: number;
}

/** RECONCILIATION Part 3 u16 error registry (the subset the daemon imports use). */
export const enum AbiError {
    DaemonScheduleRejected = 0x0403,
    DaemonCallFailed = 0x0405,
}

/** Encode a u16 subsystem error per the Part 3 negative-return bridge:
 *  `code = (-v) - 0x10000`, so `v = -(0x10000 + code)`. */
export function encodeAbiError(code: number): number {
    return -(0x10000 + code);
}

/** The minimal scheduler/leader view the `daemon.*` imports read. Implemented by
 *  the resident `DaemonHost`. */
export interface DaemonRuntime {
    isLeader(): boolean;
    /** Monotonic fencing token; bumps on each (re)start. */
    epoch(): bigint;
    /** Number of registered `@scheduled` tasks. */
    taskCount(): number;
    /** Next computed fire time (epoch ms) for `taskId`, or `null` if unknown. */
    nextFireMs(taskId: number): number | null;
}

/** A host-import map: each value is a function over i32 args (i64 params are typed
 *  `number | bigint` individually, matching the existing db/crypto import maps). */
type HostFnMap = Record<string, (...args: number[]) => number | bigint>;

/** Build the `daemon.*` host imports, closing over the resident `DaemonRuntime`.
 *  These imports do not read guest memory (they answer from the resident scheduler
 *  state), so they take no `MemoryRef`. */
export function buildDaemonNamespace(rt: DaemonRuntime): HostFnMap {
    return {
        'daemon.is_leader': (): number => (rt.isLeader() ? 1 : 0),
        'daemon.current_epoch': (): bigint => rt.epoch(),
        // The dev lease never expires, so yield/sleep never report LEASE_LOST.
        'daemon.yield': (): number => 0,
        'daemon.sleep_ms': (_ms: number | bigint): number => 0,
        'daemon.task_count': (): number => rt.taskCount(),
        'daemon.next_fire_ms': (taskId: number): bigint => {
            const at = rt.nextFireMs(taskId);
            return at === null
                ? BigInt(encodeAbiError(AbiError.DaemonScheduleRejected))
                : BigInt(at);
        },
        // Outbound HTTP call stub: dev returns a "call failed" sentinel rather than
        // performing real network I/O from a synchronous wasm import (section 5.4).
        'daemon.http_call': (
            _reqPtr: number,
            _reqLen: number,
            _outPtr: number,
            _outCap: number,
        ): bigint => BigInt(encodeAbiError(AbiError.DaemonCallFailed)),
    };
}

/** Per-cold-box host state (DB + crypto scratch), analogous to `DispatchState`. */
export interface DaemonState {
    crypto: CryptoState;
    db: DbDevState;
}

export function freshDaemonState(): DaemonState {
    return { crypto: freshCryptoState(), db: freshDbState() };
}

/**
 * The full `env` import object for the cold daemon box: the request-surface env
 * MINUS the response/stream functions (built by `buildEnvImports`), PLUS the
 * `daemon.*` namespace. The cold box has no `handle` entry and no response
 * surface.
 */
export function buildDaemonImports(
    ref: MemoryRef,
    state: DaemonState,
    rt: DaemonRuntime,
): WebAssembly.Imports {
    return {
        env: {
            ...buildEnvImports(ref, state),
            ...buildCryptoImports(ref, state.crypto),
            ...buildDatabaseImports(ref, state.db),
            ...buildDaemonNamespace(rt),
        },
    };
}

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
 * These live in their OWN wasm module namespace, `daemon`, with BARE names, exactly
 * as the edge registers them (toil-backend `src/wasm/cold/imports.rs`, `NS_DAEMON`).
 * They are NOT dotted names under `env` like `data.*` / `crypto.*` are: a cold box
 * that declares them that way resolves here and then trap-stubs at the edge, which
 * is the one shape of drift a dev emulator must never hide.
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
    DaemonNotLeader = 0x0401,
    DaemonLeaseLost = 0x0402,
    DaemonCallFailed = 0x0405,
}

/** The edge's `EPOCH_NONE` / "no such task" sentinel: a plain -1, not a bridged error. */
const DAEMON_NONE = -1n;

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

/** Build the `daemon` namespace, closing over the resident `DaemonRuntime`. The names
 *  are BARE (`is_leader`, not `daemon.is_leader`): they are keyed under the `daemon`
 *  wasm module, matching the edge. These imports do not read guest memory (they answer
 *  from the resident scheduler state), so they take no `MemoryRef`. */
export function buildDaemonNamespace(rt: DaemonRuntime): HostFnMap {
    return {
        is_leader: (): number => (rt.isLeader() ? 1 : 0),
        // The edge answers -1 (EPOCH_NONE) when this node does not hold the lease.
        current_epoch: (): bigint => (rt.isLeader() ? rt.epoch() : DAEMON_NONE),
        // The dev lease never expires, so yield/sleep never report LEASE_LOST.
        yield: (): number => 0,
        sleep_ms: (_ms: number | bigint): number => 0,
        task_count: (): number => rt.taskCount(),
        // An unknown / never-firing task is -1 at the edge, NOT a bridged error.
        next_fire_ms: (taskId: number): bigint => {
            const at = rt.nextFireMs(taskId);
            return at === null ? DAEMON_NONE : BigInt(at);
        },
        // Outbound HTTP call stub: dev returns a "call failed" sentinel rather than
        // performing real network I/O from a synchronous wasm import (section 5.4).
        http_call: (
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
 * The import object for the cold daemon box: the request-surface `env` MINUS the
 * response/stream functions (built by `buildEnvImports`), plus the separate
 * `daemon` module. The cold box has no `handle` entry and no response surface.
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
        },
        daemon: buildDaemonNamespace(rt),
    };
}

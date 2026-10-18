import { resetImageState } from '../images/index.js';
import { devDb } from '../db/database.js';
import { deriveChangesFrame } from '../db/changes.js';
import { dbBudgetSnapshot, type DbBudgetSnapshot } from '../db/limits.js';
import type { DaemonHttpMock } from './http.js';
import { deriveContinuationKey, deriveCheckpointKey } from '../db/derives.js';
/**
 * Dev DAEMON (L4) emulation. Loads `release-cold.wasm` ONCE into a single resident
 * instance, calls the guest `daemon_start()` export (RECONCILIATION Part 2; runs
 * once, `0` ok), registers the `@scheduled` tasks from `toildaemon.catalog`, and
 * drives them: interval tasks via `setInterval`, cron tasks via a one-shot
 * `setTimeout` armed at the next minute whose precomputed bitmasks all pass (F6;
 * never a runtime cron-string parse).
 *
 * Single-process at-most-once: there is exactly one dev process, so the leader
 * stub is always true and the lease never expires. The epoch is a fencing-token
 * stub that bumps on each (re)start, so guest code that compares epochs behaves
 * like the edge across a cold-artifact hot reload. A trapped tick does NOT tear
 * down the long-lived daemon box (deliberate asymmetry with the stream box); the
 * overlap guard (`ticking` set) prevents a slow tick from piling up
 * (overlap_policy 0 = skip-if-running).
 *
 * DAEMON path only; stream + WebSocket dev emulation is Phase 4.
 */

import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

import pc from 'picocolors';
import {
    DbFunctionKind,
    persistDb,
    parseDerives,
    derivesForWrites,
    type DeriveEntry,
    commitDeriveCheckpoints,
    setDbCatalog,
} from '../db/index.js';
import { flushMaterializations, queueMaterialization } from '../db/materialization.js';
import { resetDbLimits } from '../db/limits.js';

import { type MemoryRef } from '../runtime/host.js';
import { parseSurface } from '../wasm/surface.js';
import {
    type CronMasks,
    type DaemonCatalog,
    parseDaemonCatalog,
    type ScheduledTask,
} from './catalog.js';
import { cronMatches, cronNeverFires, nextCronFireMs } from './cron.js';
import {
    buildDaemonImports,
    type DaemonRuntime,
    type DaemonState,
    freshDaemonState,
    type ResolvedDaemonConfig,
} from './host.js';

interface ColdExports {
    readonly memory: WebAssembly.Memory;
    readonly daemon_start: () => number;
    readonly scheduled_tick: (taskId: number) => bigint;
    /** OPTIONAL: the host calls it before `daemon_start` if exported (Part 2). */
    readonly init?: () => number;
    readonly derive_run?: (id: number) => bigint;
}

/** RECONCILIATION Part 3 decode of a negative packed-i64 return, for logging. */
function decodeAbiError(ret: bigint): string {
    if (ret >= 0n) return 'ok';
    if (ret === -1n) return 'STATUS_TOO_SMALL';
    if (ret === -2n) return 'STATUS_ABSENT';
    if (ret <= -0x10000n) return '0x' + ((-ret - 0x10000n) & 0xffffn).toString(16).padStart(4, '0');
    if (ret <= -1000n) return 'DB(TDL ' + String(-ret - 1000n) + ')';
    return String(ret);
}

/**
 * Whether the daemon emulator should run for this dev process and artifact. Per
 * doc 08 section 5.1: `nodeMode` is `daemon` or `all`, the cold artifact's
 * `toil.surface` declares a daemon surface, AND `parseDaemonCatalog` returns
 * non-null with a daemon present.
 */
export function daemonEmulationEnabled(nodeMode: string): boolean {
    return nodeMode === 'daemon' || nodeMode === 'all';
}

export interface DaemonHostOptions {
    readonly clock?: () => number;
    readonly httpMock?: DaemonHttpMock;
}

export interface DaemonTaskResult {
    task: string;
    atMillis: number;
    status: 'ok' | 'failed' | 'trapped' | 'skipped' | 'inactive' | 'not-found';
    returnCode: bigint | null;
    error: string | null;
    durationMs: number;
    budget: DbBudgetSnapshot;
}

export class DaemonHost implements DaemonRuntime {
    private taskTime: number | null = null;
    private module: WebAssembly.Module | null = null;
    private instance: WebAssembly.Instance | null = null;
    private exports: ColdExports | null = null;
    private state: DaemonState = freshDaemonState();
    private catalog: DaemonCatalog | null = null;
    private loadedMtimeMs = -1;
    private running = false;
    /** Fencing-token stub (00 D3); bumps on each (re)start. */
    private epochValue = 0n;
    /** task_index -> active interval/timeout handle. */
    private timers = new Map<number, NodeJS.Timeout>();
    private deriveRetryTimer: NodeJS.Timeout | null = null;
    /** task_index -> next computed fire time (epoch ms), for daemon.next_fire_ms. */
    private nextFire = new Map<number, number>();
    /** task_index of ticks currently executing (overlap guard). */
    private ticking = new Set<number>();
    private derives: readonly DeriveEntry[] = [];
    private readonly pendingDerives = new Set<number>();

    constructor(
        private readonly coldWasmPath: string,
        private readonly cfg: ResolvedDaemonConfig,
        private readonly nodeMode: string,
        private readonly log: (s: string) => void = (s) => process.stdout.write(s),
        private readonly options: DaemonHostOptions = {},
    ) {}

    get httpMock(): DaemonHttpMock | undefined {
        return this.options.httpMock;
    }

    private now(): number {
        return this.taskTime ?? this.options.clock?.() ?? Date.now();
    }

    /** Run a catalogued task at a deterministic guest time without changing Date.now. */
    runTask(name: string, atMillis: number = this.now()): DaemonTaskResult {
        if (!Number.isSafeInteger(atMillis) || atMillis < 0)
            throw new RangeError('atMillis must be a nonnegative safe integer');
        const task = this.tasks.find((task) => task.name === name);
        if (task === undefined)
            return {
                task: name,
                atMillis,
                status: 'not-found',
                returnCode: null,
                error: 'Unknown task',
                durationMs: 0,
                budget: dbBudgetSnapshot(this.state.db),
            };
        const previous = this.taskTime;
        this.taskTime = atMillis;
        try {
            return this.runTick(task);
        } finally {
            this.taskTime = previous;
        }
    }

    /** Whether the daemon box is currently resident and started. */
    get active(): boolean {
        return this.running;
    }

    get tasks(): readonly ScheduledTask[] {
        return this.catalog?.tasks ?? [];
    }

    /** Test/dev introspection for fixtures that export scalar counters. */
    callI32Export(name: string): number | null {
        const fn = (this.exports as unknown as Record<string, unknown> | null)?.[name];
        if (typeof fn !== 'function') return null;
        const value = (fn as () => number)();
        return Number.isFinite(value) ? value : null;
    }

    // --- DaemonRuntime (the daemon.* host imports read these) ---
    isLeader(): boolean {
        return true; // single dev process is always the leader
    }
    epoch(): bigint {
        return this.epochValue;
    }
    taskCount(): number {
        return this.catalog?.tasks.length ?? 0;
    }
    nextFireMs(taskId: number): number | null {
        return this.nextFire.get(taskId) ?? null;
    }

    /**
     * (Re)load on mtime change, mirroring `WasmServerModule.refresh`. A cold-artifact
     * change PAUSES + RESTARTS the daemon with a bumped epoch (section 9.1). Returns
     * `true` when a (re)load happened.
     */
    refresh(): boolean {
        if (!daemonEmulationEnabled(this.nodeMode)) return false;
        let mtimeMs: number;
        try {
            mtimeMs = fs.statSync(this.coldWasmPath).mtimeMs;
        } catch {
            // Cold artifact gone -> stop a running daemon, stay idle.
            if (this.running) this.stop();
            this.module = null;
            this.loadedMtimeMs = -1;
            return false;
        }
        if (this.module !== null && mtimeMs === this.loadedMtimeMs) return false;

        const bytes = fs.readFileSync(this.coldWasmPath);

        // The cold artifact must declare a daemon surface and a non-null catalog,
        // else the emulator stays off (fail-closed; section 3.3 / 5.1).
        const surface = parseSurface(bytes);
        if (surface === 'invalid') {
            this.log(
                pc.red('  ✗ cold artifact toil.surface is corrupt; daemon not started') + '\n',
            );
            if (this.running) this.stop();
            this.loadedMtimeMs = mtimeMs;
            return false;
        }
        if (surface.targetMode !== 'cold') {
            this.log(
                pc.yellow('  ! ') +
                    pc.dim('cold slot holds a hot-mode artifact; ignoring daemon emulator') +
                    '\n',
            );
            if (this.running) this.stop();
            this.module = null;
            this.catalog = null;
            this.loadedMtimeMs = mtimeMs;
            return false;
        }
        const catalog = parseDaemonCatalog(bytes);
        const declaresDaemon = surface.flags.daemon && (catalog?.hasDaemon ?? false);

        // A restart: stop the old box (timers + instance), bump epoch, start fresh.
        if (this.running) this.stop();

        if (!declaresDaemon || catalog === null || !catalog.hasDaemon) {
            // No daemon in this artifact: load nothing, stay idle.
            this.module = null;
            this.catalog = null;
            this.loadedMtimeMs = mtimeMs;
            return false;
        }

        this.module = new WebAssembly.Module(bytes);
        setDbCatalog(bytes, true);
        this.derives = parseDerives(bytes);
        this.pendingDerives.clear();
        for (const derive of this.derives) this.pendingDerives.add(derive.deriveId);
        this.catalog = catalog;
        this.loadedMtimeMs = mtimeMs;
        this.epochValue += 1n; // fencing token bumps on each (re)start
        this.start();
        return true;
    }

    /** Instantiate the cold box, run daemon_start once, register the tasks. */
    private start(): void {
        if (this.module === null || this.catalog === null) return;
        const ref: MemoryRef = { memory: null, now: () => this.now() };
        this.state = freshDaemonState();
        this.state.db.knownDerives = new Set(this.derives.map(deriveContinuationKey));
        this.state.db.functionKind = DbFunctionKind.Action;
        const imports = buildDaemonImports(ref, this.state, this);

        // Fail-closed up front, with names, when the cold box imports anything outside its allowed
        // surface (the request env subset + crypto + @data, and the separate `daemon` module; NO
        // response/stream functions). Mirrors `WasmServerModule.assertImportSurface` (section 7.1).
        // Both namespaces are checked: `daemon.*` is its own wasm module at the edge, so a guest
        // that declares those names under `env` must fail HERE rather than trap only in production.
        // A non-function import is rejected outright, as the edge does (`NonFunctionImport`):
        // no memory/global/table is ever registered, so leaving one to fail later would
        // surface as an opaque LinkError rather than a named, fail-closed diagnostic.
        const provided = imports as Record<string, Record<string, unknown>>;
        const missing = WebAssembly.Module.imports(this.module)
            .filter(
                (i) => i.kind !== 'function' || !Object.hasOwn(provided[i.module] ?? {}, i.name),
            )
            .map((i) => `${i.module}.${i.name}${i.kind === 'function' ? '' : ` (${i.kind})`}`);
        if (missing.length > 0) {
            this.log(
                pc.red(
                    `  ✗ cold daemon wasm imports unsupported host functions: ${missing.join(', ')}`,
                ) + '\n',
            );
            this.module = null;
            return;
        }

        this.instance = new WebAssembly.Instance(this.module, imports);
        this.exports = this.instance.exports as unknown as ColdExports;
        ref.memory = this.exports.memory;
        if (this.derives.length > 0 && typeof this.exports.derive_run !== 'function') {
            this.log(pc.red('  ✗ cold materializers require derive_run(i32) -> i64') + '\n');
            this.instance = null;
            this.exports = null;
            return;
        }

        try {
            if (typeof this.exports.init === 'function') {
                const initRc = this.exports.init();
                if (initRc !== 0) {
                    this.log(
                        pc.red(`  ✗ init() returned ${String(initRc)}; daemon not running`) + '\n',
                    );
                    this.instance = null;
                    this.exports = null;
                    return;
                }
                this.state.db.logMessages = 0;
                resetDbLimits(this.state.db);
            }
            resetImageState(this.state.images);
            this.state.db.functionKind = this.catalog.startupKind;
            resetDbLimits(this.state.db);
            const rc = this.exports.daemon_start();
            if (rc !== 0) {
                this.log(
                    pc.red(`  ✗ daemon_start() returned ${String(rc)}; daemon not running`) + '\n',
                );
                this.instance = null;
                this.exports = null;
                return;
            }
        } catch (e) {
            // A trap in daemon_start leaves the daemon stopped; surface it (do not
            // retry-loop in dev, mirroring the request-path error handling).
            this.log(pc.red(`  ✗ daemon_start() trapped: ${String(e)}`) + '\n');
            this.instance = null;
            this.exports = null;
            return;
        } finally {
            this.materializeWrites();
        }

        this.running = true;
        this.deriveRetryTimer = setInterval(() => {
            if (
                this.running &&
                (this.pendingDerives.size > 0 ||
                    this.derives.some((derive) =>
                        devDb.pendingContinuations().has(deriveContinuationKey(derive)),
                    )) &&
                this.isLeader()
            )
                this.materializeWrites();
        }, 1000);
        this.deriveRetryTimer.unref?.();
        const limited = this.catalog.tasks.slice(0, this.cfg.maxTasks);
        for (const task of limited) this.registerTask(task);
        this.log(
            pc.green('  ⏱ ') +
                pc.dim(
                    `daemon started (epoch ${String(this.epochValue)}, ${String(limited.length)} task${
                        limited.length === 1 ? '' : 's'
                    })`,
                ) +
                '\n',
        );
    }

    /** Clear timers, drop the resident instance. In-flight ticks finish on their own
     *  (the overlap guard prevents a NEW tick; a running one completes). */
    private stop(): void {
        if (this.deriveRetryTimer !== null) clearInterval(this.deriveRetryTimer);
        this.deriveRetryTimer = null;
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        this.nextFire.clear();
        // Best-effort guest stop hook, if the artifact exports one.
        const stop = (this.exports as unknown as { daemon_stop?: () => void } | null)?.daemon_stop;
        if (typeof stop === 'function') {
            try {
                stop();
            } catch {
                /* ignore a trap in the optional stop hook */
            }
        }
        this.instance = null;
        this.exports = null;
        this.running = false;
    }

    private registerTask(task: ScheduledTask): void {
        if (task.schedule.kind === 'interval') {
            const ms = Math.max(1000, task.schedule.ms || this.cfg.defaultIntervalMs);
            this.nextFire.set(task.taskIndex, Date.now() + ms);
            const handle = setInterval(() => {
                this.nextFire.set(task.taskIndex, Date.now() + ms);
                this.runTick(task);
            }, ms);
            // Do not keep the event loop alive solely for the dev scheduler.
            handle.unref?.();
            this.timers.set(task.taskIndex, handle);
        } else {
            const masks = task.schedule.masks;
            if (cronNeverFires(masks)) {
                this.log(
                    pc.yellow('  ! ') +
                        pc.dim(
                            `@scheduled ${task.name} has an unsatisfiable cron mask; skipping (DAEMON_SCHEDULE_REJECTED)`,
                        ) +
                        '\n',
                );
                return;
            }
            this.armCron(task, masks);
        }
    }

    /** Arm a one-shot timer to the next cron fire time, re-arming after each tick. */
    private armCron(task: ScheduledTask, masks: CronMasks): void {
        const next = nextCronFireMs(masks, Date.now());
        if (next === null) {
            this.nextFire.delete(task.taskIndex);
            return;
        }
        this.nextFire.set(task.taskIndex, next);
        const delay = Math.max(0, next - Date.now());
        const handle = setTimeout(() => {
            // Guard against a coarse-timer early fire: only run when the masks
            // actually match the current minute (they should by construction).
            if (cronMatches(masks, new Date())) this.runTick(task);
            if (this.running) this.armCron(task, masks);
        }, delay);
        handle.unref?.();
        this.timers.set(task.taskIndex, handle);
    }

    /** Fire one `@scheduled` task via `scheduled_tick(task_id)` (Part 2). */
    private runTick(task: ScheduledTask): DaemonTaskResult {
        const result: DaemonTaskResult = {
            task: task.name,
            atMillis: this.now(),
            status: 'ok',
            returnCode: null,
            error: null,
            durationMs: 0,
            budget: dbBudgetSnapshot(this.state.db),
        };
        if (!this.running || this.exports === null) {
            result.status = 'inactive';
            return result;
        }
        if (this.ticking.has(task.taskIndex) || !this.isLeader()) {
            result.status = 'skipped';
            return result;
        }
        this.ticking.add(task.taskIndex);
        resetImageState(this.state.images);
        this.state.db.functionKind = task.functionKind;
        this.state.db.logMessages = 0;
        resetDbLimits(this.state.db);
        this.state.db.continuationRequested = false;
        this.state.db.manualDerive = false;
        this.state.db.budgetKind = null;
        this.state.db.writtenCollections.clear();
        this.state.db.changeCandidates.clear();
        this.state.db.changeCandidateBytes = 0;
        this.state.db.changesOverflow = false;
        const startedAt = performance.now();
        try {
            result.returnCode = this.exports.scheduled_tick(task.taskIndex);
            if (result.returnCode < 0n) {
                result.status = 'failed';
                result.error = decodeAbiError(result.returnCode);
                this.log(
                    pc.yellow(`  ⏱ @scheduled ${task.name} returned error ${result.error}`) + '\n',
                );
            }
        } catch (error) {
            result.status = 'trapped';
            result.error = String(error);
            this.log(pc.red(`  ✗ @scheduled ${task.name} trapped: ${result.error}`) + '\n');
        } finally {
            result.budget = dbBudgetSnapshot(this.state.db);
            try {
                this.materializeWrites();
            } finally {
                result.durationMs = performance.now() - startedAt;
                if (result.durationMs > this.cfg.tickBudgetMs)
                    this.log(
                        pc.yellow(
                            `  ⏱ @scheduled ${task.name} took ${result.durationMs}ms (> tickBudgetMs ${this.cfg.tickBudgetMs})`,
                        ) + '\n',
                    );
                this.ticking.delete(task.taskIndex);
            }
        }
        return result;
    }

    /** Tear the daemon down for good (dev-server shutdown). */
    private materializeWrites(): void {
        if (this.derives.length > 0 && this.exports?.derive_run !== undefined) {
            const queued = devDb.pendingContinuations();
            for (const derive of this.derives)
                if (queued.has(deriveContinuationKey(derive)))
                    this.pendingDerives.add(derive.deriveId);
            const retrying = new Set(this.pendingDerives);
            for (const derive of derivesForWrites(this.derives, this.state.db.writtenCollections))
                this.pendingDerives.add(derive.deriveId);
            const db = this.state.db;
            const kind = db.functionKind;
            try {
                db.functionKind = DbFunctionKind.Derive;
                for (const derive of this.derives.filter((d) =>
                    this.pendingDerives.has(d.deriveId),
                )) {
                    db.deriveChanges = deriveChangesFrame(
                        db,
                        derive.dbName,
                        retrying.has(derive.deriveId),
                    );
                    db.continuationRequested = false;
                    db.deriveId = derive.deriveId;
                    db.deriveKey = deriveCheckpointKey(derive);
                    resetImageState(this.state.images);
                    db.logMessages = 0;
                    resetDbLimits(db);
                    db.pendingCheckpoints.clear();
                    try {
                        const rc = this.exports.derive_run(derive.deriveId);
                        if (rc !== 0n) throw new Error(`derive_run returned ${String(rc)}`);
                        commitDeriveCheckpoints(db);
                        const key = deriveContinuationKey(derive),
                            token = queued.get(key);
                        if (token !== undefined) devDb.acknowledgeContinuation(key, token);
                        this.pendingDerives.delete(derive.deriveId);
                    } catch (error) {
                        this.log(
                            pc.red(
                                `  ✗ daemon derive ${derive.dbName}.${derive.methodName} failed; retry in one second: ${String(error)}`,
                            ) + '\n',
                        );
                        break;
                    }
                }
            } finally {
                db.functionKind = kind;
                db.pendingCheckpoints.clear();
            }
        } else {
            for (const collection of this.state.db.writtenCollections)
                queueMaterialization(collection);
            flushMaterializations();
        }
        persistDb();
        this.state.db.continuationRequested = false;
        this.state.db.manualDerive = false;
        this.state.db.budgetKind = null;
        this.state.db.writtenCollections.clear();
        this.state.db.changeCandidates.clear();
        this.state.db.changeCandidateBytes = 0;
        this.state.db.changesOverflow = false;
    }

    /** Tear the daemon down for good (dev-server shutdown). */
    close(): void {
        if (this.running) this.stop();
        this.module = null;
        this.catalog = null;
    }
}

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

import pc from 'picocolors';

import { type MemoryRef } from '../runtime/host.js';
import { devMemoryStore } from '../mstore/store.js';
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

export class DaemonHost implements DaemonRuntime {
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
    /** task_index -> next computed fire time (epoch ms), for daemon.next_fire_ms. */
    private nextFire = new Map<number, number>();
    /** task_index of ticks currently executing (overlap guard). */
    private ticking = new Set<number>();

    constructor(
        private readonly coldWasmPath: string,
        private readonly cfg: ResolvedDaemonConfig,
        private readonly nodeMode: string,
        private readonly log: (s: string) => void = (s) => process.stdout.write(s),
    ) {}

    /** Whether the daemon box is currently resident and started. */
    get active(): boolean {
        return this.running;
    }

    get tasks(): readonly ScheduledTask[] {
        return this.catalog?.tasks ?? [];
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
            this.log(pc.red('  ✗ cold artifact toil.surface is corrupt; daemon not started') + '\n');
            if (this.running) this.stop();
            this.loadedMtimeMs = mtimeMs;
            return false;
        }
        if (surface !== 'absent' && surface.targetMode !== 'cold')
            this.log(
                pc.yellow('  ! ') +
                    pc.dim('cold slot holds a hot-mode artifact; ignoring daemon emulator') +
                    '\n',
            );
        const catalog = parseDaemonCatalog(bytes);
        const declaresDaemon =
            (surface === 'absent' ? false : surface.flags.daemon) || (catalog?.hasDaemon ?? false);

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
        this.catalog = catalog;
        this.loadedMtimeMs = mtimeMs;
        this.epochValue += 1n; // fencing token bumps on each (re)start
        this.start();
        return true;
    }

    /** Instantiate the cold box, run daemon_start once, register the tasks. */
    private start(): void {
        if (this.module === null || this.catalog === null) return;
        const ref: MemoryRef = { memory: null };
        this.state = freshDaemonState();
        const imports = buildDaemonImports(ref, this.state, this, devMemoryStore);

        // Fail-closed up front, with names, when the cold box imports anything outside its allowed
        // surface (the request env subset + crypto + @data + daemon.* + mstore.*; NO response/
        // stream functions). Mirrors `WasmServerModule.assertImportSurface` (section 7.1).
        const provided = new Set(Object.keys((imports as { env: Record<string, unknown> }).env));
        const missing = WebAssembly.Module.imports(this.module)
            .filter((i) => i.kind === 'function' && (i.module !== 'env' || !provided.has(i.name)))
            .map((i) => `${i.module}.${i.name}`);
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

        try {
            if (typeof this.exports.init === 'function') this.exports.init();
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
        }

        this.running = true;
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
    private runTick(task: ScheduledTask): void {
        if (!this.running || this.exports === null) return;
        if (this.ticking.has(task.taskIndex)) {
            // overlap_policy 0 = skip-if-running: a slow tick must not pile up.
            this.log(
                pc.dim(`  ⏱ @scheduled ${task.name} overran its interval; skipping a tick`) + '\n',
            );
            return;
        }
        if (!this.isLeader()) return; // always true in dev; kept for parity
        this.ticking.add(task.taskIndex);
        const startedAt = Date.now();
        try {
            const ret = this.exports.scheduled_tick(task.taskIndex); // packed-i64
            if (ret < 0n)
                this.log(
                    pc.yellow(
                        `  ⏱ @scheduled ${task.name} returned error ${decodeAbiError(ret)}`,
                    ) + '\n',
                );
        } catch (e) {
            // A trapped tick does NOT tear down the long-lived daemon box (unlike a
            // stream box); the next tick runs normally on the same memory.
            this.log(pc.red(`  ✗ @scheduled ${task.name} trapped: ${String(e)}`) + '\n');
        } finally {
            const took = Date.now() - startedAt;
            if (took > this.cfg.tickBudgetMs)
                this.log(
                    pc.yellow(
                        `  ⏱ @scheduled ${task.name} took ${String(took)}ms (> tickBudgetMs ${String(
                            this.cfg.tickBudgetMs,
                        )})`,
                    ) + '\n',
                );
            this.ticking.delete(task.taskIndex);
        }
    }

    /** Tear the daemon down for good (dev-server shutdown). */
    close(): void {
        if (this.running) this.stop();
        this.module = null;
        this.catalog = null;
    }
}

import pc from 'picocolors';
import { MessageChannel, Worker } from 'node:worker_threads';

import { DaemonHost, daemonEmulationEnabled, type DaemonHostOptions } from './index.js';
import type { ResolvedDaemonConfig } from './host.js';
import { serveCalls } from './rpc.js';
import { storageReceiver } from './storage.js';

export interface DaemonRuntimeOptions {
    readonly coldWasmFile?: string;
    /** Request artifact for fallback materializers; those also execute on the L4 worker. */
    readonly hotWasmFile?: string;
    readonly nodeMode?: string;
    readonly daemon?: ResolvedDaemonConfig;
    readonly logging?: boolean;
    readonly pollMs?: number;
    readonly sharedImports?: DaemonHostOptions['sharedImports'];
}

export interface RunningDaemonRuntime {
    readonly host: DaemonHost;
    close(): void;
}

/** Starts the shared cold-artifact daemon runtime used by both `dev` and `start`. */
export function startDaemonRuntime(options: DaemonRuntimeOptions): RunningDaemonRuntime | null {
    const nodeMode = options.nodeMode ?? 'all';
    if (
        options.coldWasmFile === undefined ||
        !(options.daemon?.enabled ?? daemonEmulationEnabled(nodeMode)) ||
        options.daemon === undefined
    ) {
        return null;
    }

    const host = new DaemonHost(options.coldWasmFile, options.daemon, 'daemon', undefined, {
        logging: options.logging,
        sharedImports: options.sharedImports,
    });
    const pollDaemon = (): void => {
        try {
            host.refresh();
        } catch (e) {
            process.stdout.write(pc.red(`  x daemon reload failed: ${String(e)}`) + '\n');
        }
    };
    pollDaemon();
    const timer = setInterval(pollDaemon, options.pollMs ?? 500);
    timer.unref?.();

    return {
        host,
        close: (): void => {
            clearInterval(timer);
            host.close();
        },
    };
}

export interface RunningDaemonWorker {
    readonly threadId: number;
    /** Resolves after the first cold-artifact load, including daemon_start. */
    readonly ready: Promise<void>;
    close(): Promise<void>;
}

/** A single L4 worker per server, independent of its HTTP worker count. */
export function startDaemonWorker(
    options: Omit<DaemonRuntimeOptions, 'sharedImports'>,
): RunningDaemonWorker | null {
    if (
        options.coldWasmFile === undefined ||
        options.daemon === undefined ||
        !(options.daemon.enabled ?? daemonEmulationEnabled(options.nodeMode ?? 'all'))
    )
        return null;

    const { port1, port2 } = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(4));
    serveCalls(port1, signal, storageReceiver());
    let worker: Worker;
    try {
        worker = new Worker(new URL('./worker.js', import.meta.url), {
            name: 'toil-l4',
            workerData: { options, port: port2, signal },
            transferList: [port2],
        });
    } catch (error) {
        port1.close();
        port2.close();
        throw error;
    }
    let exited = false;
    const exit = new Promise<void>((resolve) =>
        worker.once('exit', () => {
            exited = true;
            port1.close();
            resolve();
        }),
    );
    const ready = new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve());
        worker.once('error', reject);
        worker.once('exit', (code) =>
            reject(new Error(`L4 worker exited before ready (${String(code)})`)),
        );
    });
    // The HTTP server remains available if L4 fails. Do not replay onStart by auto-restarting it.
    void ready.catch((error: unknown) =>
        process.stderr.write(`toiljs L4 worker failed: ${String(error)}\n`),
    );
    worker.on('error', (error) => {
        process.stderr.write(`toiljs L4 worker error: ${String(error)}\n`);
    });
    let closing: Promise<void> | undefined;
    return {
        threadId: worker.threadId,
        ready,
        close: () =>
            (closing ??= (async () => {
                if (exited) return;
                worker.postMessage('shutdown');
                // A synchronous guest can loop forever and never receive the shutdown message.
                const timer = setTimeout(() => {
                    void worker.terminate();
                }, 1500);
                timer.unref();
                try {
                    await exit;
                } finally {
                    clearTimeout(timer);
                }
            })()),
    };
}

import pc from 'picocolors';

import { DaemonHost, daemonEmulationEnabled } from './index.js';
import type { ResolvedDaemonConfig } from './host.js';

export interface DaemonRuntimeOptions {
    readonly coldWasmFile?: string;
    readonly nodeMode?: string;
    readonly daemon?: ResolvedDaemonConfig;
    readonly pollMs?: number;
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
        !daemonEmulationEnabled(nodeMode) ||
        options.daemon === undefined
    ) {
        return null;
    }

    const host = new DaemonHost(options.coldWasmFile, options.daemon, nodeMode);
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

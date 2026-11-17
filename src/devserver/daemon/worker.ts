import { parentPort, workerData, type MessagePort } from 'node:worker_threads';

import { startDaemonRuntime, type DaemonRuntimeOptions } from './runtime.js';
import { synchronousCaller } from './rpc.js';
import { installWorkerStorage, workerSharedImports } from './storage.js';
import { WasmServerModule } from '../runtime/module.js';

if (parentPort === null) throw new Error('L4 must run in a worker thread');
const primary = parentPort;

const { options, port, signal } = workerData as {
    options: DaemonRuntimeOptions;
    port: MessagePort;
    signal: Int32Array;
};
const call = synchronousCaller(port, signal);
installWorkerStorage(call);
// Resident boxes can trigger materializers carried only by the request artifact.
// Register a worker-local runner so background writes cannot run that guest on L1.
const hot =
    options.hotWasmFile === undefined
        ? null
        : new WasmServerModule(options.hotWasmFile, options.logging);
const refreshHot = (): void => {
    try {
        hot?.refresh();
    } catch (error) {
        process.stderr.write(`toiljs L4 materializer reload failed: ${String(error)}\n`);
    }
};
refreshHot();
const hotTimer = setInterval(refreshHot, options.pollMs ?? 500);
hotTimer.unref();
const runtime = startDaemonRuntime({
    ...options,
    sharedImports: (ref) => workerSharedImports(call, ref),
});
primary.on('message', (message: unknown) => {
    if (message !== 'shutdown') return;
    try {
        runtime?.close();
    } finally {
        clearInterval(hotTimer);
        port.close();
        primary.close();
    }
});
primary.postMessage('ready');

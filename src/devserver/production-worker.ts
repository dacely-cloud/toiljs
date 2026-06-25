import type { BuiltServerOptions, RunningBuiltServer } from './production.js';
import { startBuiltServerWorker } from './production.js';
import {
    isPrimaryToWorkerMessage,
    type PrimaryToWorkerMessage,
    type ThreadedReply,
    type ThreadedRequest,
} from './production-ipc.js';

let running: RunningBuiltServer | null = null;
let workerId = 0;
const pending = new Map<number, (reply: ThreadedReply) => void>();

function send(message: object): void {
    try {
        process.send?.(message);
    } catch {
        // The parent is gone; normal process shutdown will follow.
    }
}

function requestPrimary(request: ThreadedRequest): Promise<ThreadedReply> {
    const id = request.id;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error('primary request timed out'));
        }, 120_000);
        timeout.unref();

        pending.set(id, (reply) => {
            clearTimeout(timeout);
            resolve(reply);
        });
        send({ toil: 'request', request });
    });
}

async function start(message: Extract<PrimaryToWorkerMessage, { toil: 'start' }>): Promise<void> {
    if (running !== null) return;
    workerId = message.workerId;
    const options = message.options as BuiltServerOptions;
    running = await startBuiltServerWorker(options, {
        request: requestPrimary,
        clientCount: (count) => send({ toil: 'clientCount', workerId, count }),
    });
    send({ toil: 'ready', workerId, port: running.port });
}

async function shutdown(): Promise<void> {
    const server = running;
    running = null;
    if (server !== null) await server.close();
}

process.on('message', (value: unknown) => {
    if (!isPrimaryToWorkerMessage(value)) return;
    switch (value.toil) {
        case 'start':
            void start(value).catch((e: unknown) => {
                process.stderr.write(`toiljs production worker failed: ${String(e)}\n`);
                process.exit(1);
            });
            return;
        case 'reply': {
            const resolve = pending.get(value.id);
            if (resolve === undefined) return;
            pending.delete(value.id);
            resolve(value.reply);
            return;
        }
        case 'broadcast':
            running?.broadcast(value.message);
            return;
        case 'shutdown':
            void shutdown().finally(() => process.exit(0));
            return;
    }
});

process.once('disconnect', () => {
    void shutdown().finally(() => process.exit(0));
});

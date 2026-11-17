import { deserialize, serialize } from 'node:v8';
import { receiveMessageOnPort, type MessagePort } from 'node:worker_threads';

/** Only the background worker waits. The request thread always handles RPC asynchronously. */
export function synchronousCaller(port: MessagePort, signal: Int32Array) {
    let usable = true;
    return (request: unknown): unknown => {
        if (!usable) throw new Error('daemon storage bridge is unavailable');
        Atomics.store(signal, 0, 0);
        port.postMessage(serialize(request));
        // Poison on timeout: a late reply must never be consumed as the next operation's reply.
        if (Atomics.wait(signal, 0, 0, 120_000) === 'timed-out') {
            usable = false;
            port.close();
            throw new Error('daemon storage bridge timed out');
        }
        const reply = receiveMessageOnPort(port);
        if (reply === undefined) throw new Error('daemon storage bridge closed without a reply');
        const { result, error } = deserialize(Buffer.from(reply.message as Uint8Array)) as {
            result?: unknown;
            error?: Error;
        };
        if (error !== undefined) throw error;
        return result;
    };
}

export function serveCalls<Request>(
    port: MessagePort,
    signal: Int32Array,
    handle: (request: Request) => unknown,
): void {
    port.on('message', (bytes: Uint8Array) => {
        let reply: { result?: unknown; error?: unknown };
        try {
            reply = { result: handle(deserialize(Buffer.from(bytes)) as Request) };
        } catch (error) {
            reply = { error: error instanceof Error ? error : new Error(String(error)) };
        }
        port.postMessage(serialize(reply));
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
    });
}

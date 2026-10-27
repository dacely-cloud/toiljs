import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const queues = new Map<string, Promise<void>>();

interface Owner {
    readonly pid: number;
    readonly token: string;
}

function owner(file: string): Owner | null {
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Owner;
        return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === 'string'
            ? value
            : null;
    } catch {
        return null;
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

/** Serialize compiler generations, including separate toiljs processes targeting the same checkout. */
export async function withCompilerLock<T>(root: string, work: () => Promise<T>): Promise<T> {
    const canonical = fs.realpathSync(root);
    const previous = queues.get(canonical) ?? Promise.resolve();
    const next = Promise.withResolvers<undefined>();
    queues.set(canonical, next.promise);
    await previous;
    const dir = path.join(canonical, '.toil', 'compiler');
    const lock = path.join(dir, 'lock');
    const token = randomUUID();
    let acquired = false;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const deadline = Date.now() + 300_000;
        while (!acquired) {
            try {
                const fd = fs.openSync(lock, 'wx');
                acquired = true;
                try {
                    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
                } finally {
                    fs.closeSync(fd);
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const stale = owner(lock);
                if (stale && !alive(stale.pid)) {
                    // Only one process may reap a dead owner's lock. Re-read after claiming
                    // the reaper so a competing new owner can never have its lock removed.
                    const reaper = lock + '.reaping';
                    let fd: number | undefined;
                    try {
                        fd = fs.openSync(reaper, 'wx');
                        const current = owner(lock);
                        if (current?.token === stale.token && !alive(current.pid))
                            fs.unlinkSync(lock);
                    } catch (failure) {
                        if (
                            (failure as NodeJS.ErrnoException).code !== 'EEXIST' &&
                            (failure as NodeJS.ErrnoException).code !== 'ENOENT'
                        )
                            throw failure;
                    } finally {
                        if (fd !== undefined) {
                            fs.closeSync(fd);
                            fs.rmSync(reaper, { force: true });
                        }
                    }
                }
                if (Date.now() >= deadline)
                    throw new Error(
                        `Another server build holds ${lock}. Check its process before removing a stale lock.`,
                        { cause: error },
                    );
                await setTimeout(50);
            }
        }
        // A killed parent cannot publish its isolated staging directory. Prune only
        // task-owned abandoned generations; live compiler owners keep their work.
        for (const entry of fs.readdirSync(dir)) {
            const match = /^pending-(\d+)-/.exec(entry);
            if (match && !alive(Number(match[1])))
                fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        }
        return await work();
    } finally {
        try {
            const recorded = acquired ? owner(lock) : null;
            if (acquired && (recorded === null || recorded.token === token))
                fs.rmSync(lock, { force: true });
        } finally {
            next.resolve(undefined);
            if (queues.get(canonical) === next.promise) queues.delete(canonical);
        }
    }
}

/** Run hot-artifact materializers after writes from resident background boxes. */
const runners = new Map<string, (written: ReadonlySet<string>) => void>();
const pending = new Set<string>();
let scheduled = false;

export function registerMaterializer(
    key: string,
    runner: (written: ReadonlySet<string>) => void,
): void {
    runners.set(key, runner);
}

export function unregisterMaterializer(key: string): void {
    runners.delete(key);
}

export function queueMaterialization(collection: string): void {
    pending.add(collection);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flushMaterializations);
}

export function flushMaterializations(): void {
    scheduled = false;
    if (pending.size === 0) return;
    const written = new Set(pending);
    pending.clear();
    for (const runner of runners.values()) runner(written);
}

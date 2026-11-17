import { devDb, DevDatabase, installDatabaseBackend } from '../db/database.js';
import { dbLimitUsage, restoreDbLimitUsage } from '../db/limits.js';
import { queueMaterialization, withoutMaterializationScheduling } from '../db/materialization.js';
import { DbFunctionKind, type DbDevState } from '../db/types.js';
import { buildEnvImports, freshDispatchState, type MemoryRef } from '../runtime/host.js';

type Call = (request: unknown) => unknown;
type Scalar = number | bigint;
interface Layout {
    /** Argument indexes of pointer/length pairs, after the ref and DB state. */
    pairs?: number[];
    idem?: number;
    output?: number;
    outputSize?: number;
}

// Copy ABI inputs, never the guest heap. L4 can have a large resident heap without
// making every database operation copy that heap onto the L1 event loop.
const keyed: Layout = { pairs: [1] };
const valued: Layout = { pairs: [1, 3] };
const writing: Layout = { pairs: [1, 3], idem: 5 };
const layouts: Record<string, Layout> = {
    resolveCollection: { pairs: [0], output: 2, outputSize: 4 },
    get: keyed,
    getMany: keyed,
    exists: keyed,
    create: writing,
    patch: writing,
    upsert: writing,
    delete: { pairs: [1], idem: 3 },
    getDelete: { pairs: [1], idem: 3 },
    uniqueLookup: keyed,
    uniqueClaim: writing,
    uniqueRelease: valued,
    membershipContains: valued,
    membershipAdd: valued,
    membershipRemove: valued,
    membershipList: keyed,
    membershipPage: valued,
    documentsScan: keyed,
    viewGet: keyed,
    viewPublish: valued,
    viewDelete: keyed,
    counterGet: keyed,
    counterAdd: { pairs: [1], idem: 4 },
    append: writing,
    appendOnce: { pairs: [1, 3, 5] },
    eventsGet: valued,
    eventsReference: valued,
    eventsRedact: keyed,
    eventsEntries: keyed,
    eventsLast: keyed,
    compareExchange: { pairs: [1, 3, 5] },
    compareDelete: valued,
    enqueue: writing,
    latest: keyed,
    since: keyed,
    capacitySetTotal: keyed,
    capacityAvailable: keyed,
    capacityReserve: { pairs: [1], idem: 5 },
    capacityConfirm: keyed,
    capacityCancel: keyed,
    'data.atomic_get': valued,
    'data.atomic_batch': { pairs: [0] },
    env_get: { pairs: [0], output: 2 },
    env_get_secure: { pairs: [0], output: 2 },
    email_send: { pairs: [0] },
    email_send_detached: { pairs: [0] },
};
const sharedServices = ['env_get', 'env_get_secure', 'email_send', 'email_send_detached'];
const storageMethods = new Set([
    'setCatalog',
    'persist',
    'pendingContinuations',
    'acknowledgeContinuation',
    'commitDeriveCheckpoints',
    'requestContinuation',
]);

interface MemoryInput {
    size: number;
    now: number;
    regions: { offset: number; bytes: Buffer }[];
}

interface StorageRequest {
    method: string;
    args: unknown[];
    db?: DbDevState;
    usage?: ReturnType<typeof dbLimitUsage>;
    memory?: MemoryInput;
}

interface StorageReply {
    value?: unknown;
    error?: Error;
    output?: { offset: number; bytes: Buffer };
    db?: DbDevState;
    usage?: ReturnType<typeof dbLimitUsage>;
}

function captureMemory(ref: MemoryRef, layout: Layout, args: Scalar[]): MemoryInput {
    if (ref.memory === null) throw new Error('daemon database memory is not bound');
    const memory = Buffer.from(ref.memory.buffer);
    const regions: MemoryInput['regions'] = [];
    const capture = (offset: number, size: number): void => {
        if (
            !Number.isInteger(offset) ||
            !Number.isInteger(size) ||
            offset < 0 ||
            size < 0 ||
            offset > memory.length ||
            size > memory.length - offset
        )
            throw new Error('daemon database input out of bounds');
        regions.push({ offset, bytes: Buffer.from(memory.subarray(offset, offset + size)) });
    };
    for (const index of layout.pairs ?? []) capture(Number(args[index]), Number(args[index + 1]));
    if (layout.idem !== undefined && args[layout.idem] !== 0)
        capture(Number(args[layout.idem]), 16);
    return { size: memory.length, now: ref.now?.() ?? Date.now(), regions };
}

/** Install in the daemon worker only; all other threads retain the real database. */
export function installWorkerStorage(call: Call): void {
    const local = new DevDatabase();
    const invoke = (method: string, args: unknown[], ref?: MemoryRef, db?: DbDevState): unknown => {
        const layout = layouts[method];
        const reply = call({
            kind: 'storage',
            method,
            args,
            db,
            usage: db === undefined ? undefined : dbLimitUsage(db),
            memory: ref === undefined ? undefined : captureMemory(ref, layout, args as Scalar[]),
        }) as StorageReply;
        if (db !== undefined) {
            Object.assign(db, reply.db);
            restoreDbLimitUsage(db, reply.usage);
            if (db.functionKind === DbFunctionKind.Job)
                for (const collection of db.writtenCollections) queueMaterialization(collection);
        }
        if (ref?.memory !== null && ref?.memory !== undefined && reply.output !== undefined)
            Buffer.from(ref.memory.buffer).set(reply.output.bytes, reply.output.offset);
        if (reply.error !== undefined) throw reply.error;
        return reply.value;
    };
    installDatabaseBackend(
        new Proxy(local, {
            get(target, key: keyof DevDatabase) {
                // These only touch per-instance scratch; keep result pulls and metadata local.
                if (key === 'takeResult' || key === 'resultSchemaVersion')
                    return target[key].bind(target);
                if (key === 'atomicImports')
                    return (ref: MemoryRef, db: DbDevState) =>
                        Object.fromEntries(
                            Object.keys(target.atomicImports(ref, db)).map((name) => [
                                name,
                                (...args: Scalar[]) => invoke(name, args, ref, db),
                            ]),
                        );
                if (Object.hasOwn(layouts, key))
                    return (ref: MemoryRef, db: DbDevState, ...args: Scalar[]) =>
                        invoke(key, args, ref, db);
                if (key === 'commitDeriveCheckpoints' || key === 'requestContinuation')
                    return (db: DbDevState) => invoke(key, [], undefined, db);
                if (storageMethods.has(key)) return (...args: unknown[]) => invoke(key, args);
                throw new Error(`Unsupported daemon database operation: ${key}`);
            },
        }),
    );
}

/** Bridge only services whose state belongs to the server (email caps, env/blob secrets). */
export function workerSharedImports(call: Call, ref: MemoryRef) {
    return Object.fromEntries(
        sharedServices.map((method) => [
            method,
            (...args: number[]) => {
                const reply = call({
                    kind: 'storage',
                    method,
                    args,
                    memory: captureMemory(ref, layouts[method], args),
                }) as StorageReply;
                if (reply.output !== undefined && ref.memory !== null)
                    Buffer.from(ref.memory.buffer).set(reply.output.bytes, reply.output.offset);
                if (reply.error !== undefined) throw reply.error;
                return reply.value as number;
            },
        ]),
    );
}

/** One receiver per daemon. It runs storage operations, never daemon guest code. */
export function storageReceiver() {
    let mirror = new WebAssembly.Memory({ initial: 0 });
    return (request: StorageRequest): StorageReply => {
        const { method, args, db, memory } = request;
        const ref: MemoryRef = { memory: null };
        if (memory !== undefined) {
            if (mirror.buffer.byteLength !== memory.size)
                mirror = new WebAssembly.Memory({ initial: memory.size / 65536 });
            for (const region of memory.regions)
                new Uint8Array(mirror.buffer).set(region.bytes, region.offset);
            ref.memory = mirror;
            ref.now = () => memory.now;
        }
        if (db !== undefined) restoreDbLimitUsage(db, request.usage);
        let value: unknown;
        let error: Error | undefined;
        try {
            value = withoutMaterializationScheduling(() => {
                if (sharedServices.includes(method)) {
                    const service = buildEnvImports(ref, freshDispatchState())[method] as (
                        ...args: unknown[]
                    ) => unknown;
                    return service(...args);
                }
                if (method.startsWith('data.atomic_')) {
                    if (db === undefined) throw new Error('Missing daemon database state');
                    return devDb.atomicImports(ref, db)[method](...(args as number[]));
                }
                const operation = devDb[method as keyof DevDatabase] as (
                    ...args: unknown[]
                ) => unknown;
                if (Object.hasOwn(layouts, method)) return operation.call(devDb, ref, db, ...args);
                if (storageMethods.has(method))
                    return operation.call(devDb, ...(db === undefined ? args : [db]));
                throw new Error(`Unsupported daemon database operation: ${method}`);
            });
        } catch (caught) {
            error = caught instanceof Error ? caught : new Error(String(caught));
        }
        const layout = layouts[method];
        let output: { offset: number; bytes: Buffer } | undefined;
        if (
            error === undefined &&
            layout?.output !== undefined &&
            typeof value === 'number' &&
            value >= 0
        ) {
            const offset = Number(args[layout.output]);
            const size = layout.outputSize ?? value;
            output = { offset, bytes: Buffer.from(mirror.buffer, offset, size) };
        }
        return { value, error, output, db, usage: db === undefined ? undefined : dbLimitUsage(db) };
    };
}

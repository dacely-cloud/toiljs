import { createHash } from 'node:crypto';
import { DataReader, DataWriter } from 'toiljs/io';
import type { MemoryRef } from '../runtime/host.js';
import { chargeDbControlWrite } from './limits.js';
import {
    ABSENT,
    CONFLICT,
    CollectionFamily,
    DbFunctionKind,
    type DbDevState,
    type DevCollectionHandle,
} from './types.js';

interface Storage {
    store: Map<string, Buffer>;
    versions: Map<string, number>;
}
interface Entry {
    coll: DevCollectionHandle;
    key: Buffer;
    expected: Buffer | null;
    value: Buffer | null;
}
function read(ref: MemoryRef, ptr: number, len: number, maximum: number): Buffer {
    const memory = ref.memory;
    if (
        memory === null ||
        ptr < 0 ||
        len < 0 ||
        len > maximum ||
        ptr > memory.buffer.byteLength ||
        len > memory.buffer.byteLength - ptr
    )
        throw new Error('Atomic input bounds');
    return Buffer.from(new Uint8Array(memory.buffer, ptr, len));
}
function collection(db: DbDevState, handle: number): DevCollectionHandle {
    const coll = db.handles[handle];
    if (
        !coll ||
        coll.family !== CollectionFamily.Record ||
        coll.replication !== 5 ||
        coll.fields?.some((f) => f.unique)
    )
        throw new Error(
            'TDL010: atomic records require localOnly Documents without @unique fields',
        );
    return coll;
}
const database = (coll: DevCollectionHandle) => coll.name.split('/')[0];
const prefix = (coll: DevCollectionHandle, partition: Buffer) =>
    '__atomic/' + JSON.stringify([database(coll), partition.toString('hex')]) + '/';
const keyOf = (coll: DevCollectionHandle, partition: Buffer, key: Buffer) =>
    prefix(coll, partition) + JSON.stringify([coll.name, key.toString('hex')]);
function mark(db: DbDevState, entries: Entry[]): void {
    db.changesOverflow = true;
    for (const entry of entries) db.writtenCollections.add(entry.coll.name);
}
export function buildAtomicImports(
    ref: MemoryRef,
    db: DbDevState,
    storage: Storage,
): Record<string, (...args: number[]) => number> {
    return {
        'data.atomic_get': (h, pp, pl, kp, kl) => {
            db.lastResult = null;
            db.lastResultVersion = -1;
            const coll = collection(db, h),
                partition = read(ref, pp, pl, 512),
                key = read(ref, kp, kl, 4096);
            if (partition.length === 0 || db.functionKind === DbFunctionKind.Admin)
                throw new Error('TDL011: atomic read not allowed');
            const id = keyOf(coll, partition, key),
                value = storage.store.get(id);
            if (value === undefined) return ABSENT;
            db.lastResult = Buffer.from(value);
            db.lastResultVersion = storage.versions.get(id) ?? 0;
            return value.length;
        },
        'data.atomic_batch': (ptr, len) => {
            db.lastResult = null;
            db.lastResultVersion = -1;
            if (db.functionKind !== DbFunctionKind.Action)
                throw new Error('TDL011: atomic commit requires an Action');
            const reader = new DataReader(read(ref, ptr, len, 132 * 1024));
            if (reader.readU8() !== 1) throw new Error('Atomic frame version');
            const partition = Buffer.from(reader.readBytes()),
                token = Buffer.from(reader.readBytes()),
                count = reader.readU32();
            if (
                partition.length < 1 ||
                partition.length > 512 ||
                token.length < 16 ||
                token.length > 64 ||
                count < 1 ||
                count > 16
            )
                throw new Error('Atomic partition, token or record limit');
            const entries: Entry[] = [],
                keys = new Set<string>();
            const request = new DataWriter().writeBytes(partition).writeU32(count);
            let bytes = partition.length + token.length + 32;
            for (let i = 0; i < count; i++) {
                const coll = collection(db, reader.readU32()),
                    key = Buffer.from(reader.readBytes());
                const expectedTag = reader.readU8();
                if (expectedTag > 1) throw new Error('Atomic expected tag');
                const expected = expectedTag === 1 ? Buffer.from(reader.readBytes()) : null;
                const valueTag = reader.readU8();
                if (valueTag > 1) throw new Error('Atomic value tag');
                const value = valueTag === 1 ? Buffer.from(reader.readBytes()) : null;
                const id = keyOf(coll, partition, key);
                if (key.length > 4096 || keys.has(id) || (expected === null && value === null))
                    throw new Error('Atomic duplicate key or invalid mutation');
                keys.add(id);
                if (entries.length && database(entries[0].coll) !== database(coll))
                    throw new Error('Atomic batch requires one database');
                entries.push({ coll, key, expected, value });
                bytes += key.length + (expected?.length ?? 0) + (value?.length ?? 0);
                request
                    .writeString(coll.name)
                    .writeU32(coll.schemaVersion)
                    .writeBytes(key)
                    .writeU8(expectedTag);
                if (expected !== null) request.writeBytes(expected);
                request.writeU8(valueTag);
                if (value !== null) request.writeBytes(value);
            }
            if (!reader.ok || reader.remaining() !== 0 || bytes > 128 * 1024)
                throw new Error('Atomic frame or byte limit');
            // Reserve all operations before looking up a token or changing data.
            chargeDbControlWrite(db, partition.length + token.length + 32, 'data.atomic_batch');
            for (const e of entries)
                chargeDbControlWrite(
                    db,
                    e.key.length + (e.expected?.length ?? 0) + (e.value?.length ?? 0),
                    'data.atomic_batch',
                );
            const digest = createHash('sha256').update(request.toBytes()).digest();
            const decision = prefix(entries[0].coll, partition) + 'token/' + token.toString('hex');
            const prior = storage.store.get(decision);
            if (prior !== undefined) {
                if (!prior.equals(digest)) return CONFLICT;
                mark(db, entries);
                return 1;
            }
            for (const entry of entries) {
                const current = storage.store.get(keyOf(entry.coll, partition, entry.key));
                if (
                    entry.expected === null
                        ? current !== undefined
                        : current === undefined || !entry.expected.equals(current)
                )
                    return 0;
            }
            // No callback, suspension, or fallible work between these mutations.
            for (const entry of entries) {
                const id = keyOf(entry.coll, partition, entry.key);
                if (entry.value === null) {
                    storage.store.delete(id);
                    storage.versions.delete(id);
                } else {
                    storage.store.set(id, entry.value);
                    storage.versions.set(id, entry.coll.schemaVersion);
                }
            }
            storage.store.set(decision, digest);
            mark(db, entries);
            return 1;
        },
    };
}

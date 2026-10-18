import { DataWriter } from 'toiljs/io';
import type { MemoryRef } from '../runtime/host.js';
import { DbFunctionKind, MAX_KEY, type DbDevState } from './types.js';

export const fullRescanFrame = (): Buffer => Buffer.from([1, 0, 0, 0, 0]);

/** Conservative operation keys, filtered by collections that actually commit. */
export function captureDbKey(db: DbDevState, ref: MemoryRef, args: number[]): void {
    if (db.functionKind === DbFunctionKind.Derive || db.changesOverflow) return;
    const [handle, ptr, len] = args;
    const coll = db.handles[handle];
    const memory = ref.memory;
    if (coll === undefined || memory === null) return;
    if (
        ptr < 0 ||
        len < 0 ||
        len > MAX_KEY ||
        ptr > memory.buffer.byteLength ||
        len > memory.buffer.byteLength - ptr
    ) {
        db.changesOverflow = true;
        db.changeCandidates.clear();
        return;
    }
    const key = Buffer.from(new Uint8Array(memory.buffer, ptr, len));
    const id = JSON.stringify([coll.name, key.toString('hex')]);
    if (db.changeCandidates.has(id)) return;
    const slash = coll.name.indexOf('/');
    const database = coll.name.slice(0, slash);
    const collection = coll.name.slice(slash + 1);
    const cost = 12 + Buffer.byteLength(database) + Buffer.byteLength(collection) + len;
    if (db.changeCandidates.size === 256 || db.changeCandidateBytes + cost + 5 > 65536) {
        db.changesOverflow = true;
        db.changeCandidates.clear();
        return;
    }
    db.changeCandidateBytes += cost;
    db.changeCandidates.set(id, { database, collection, key });
}

export function deriveChangesFrame(db: DbDevState, database: string, forceFull = false): Buffer {
    const collections = [...db.writtenCollections].filter((name) =>
        name.startsWith(`${database}/`),
    );
    const keys = [...db.changeCandidates.values()].filter(
        (entry) =>
            entry.database === database && collections.includes(`${database}/${entry.collection}`),
    );
    if (
        forceFull ||
        db.changesOverflow ||
        collections.length === 0 ||
        collections.some(
            (name) => !keys.some((entry) => `${entry.database}/${entry.collection}` === name),
        )
    )
        return fullRescanFrame();
    const writer = new DataWriter().writeU8(0).writeU32(keys.length);
    for (const entry of keys)
        writer.writeString(entry.database).writeString(entry.collection).writeBytes(entry.key);
    return Buffer.from(writer.toBytes());
}

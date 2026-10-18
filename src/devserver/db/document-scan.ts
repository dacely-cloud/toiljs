import { createHash } from 'node:crypto';
import { DataWriter } from 'toiljs/io';
import { chargeDbReadProbe, dbBudgetSnapshot } from './limits.js';
import type { DbDevState } from './types.js';

/** Dev cursor positions are stable across persistence reloads; native positions
 * use physical collection IDs. Neither format grants access to a collection. */
export function scanDocuments(
    collection: string,
    records: ReadonlyMap<string, Buffer>,
    versions: ReadonlyMap<string, number>,
    db: DbDevState,
    after: Buffer | null,
    limit: number,
): Buffer {
    const binding = createHash('sha256')
        .update(collection)
        .update('\0scan-v1')
        .digest()
        .subarray(0, 16);
    let bucket = 0;
    let hash: Buffer | null = null;
    let afterHash: Buffer | null = null;
    let afterKey: Buffer | null = null;
    if (after !== null) {
        const invalid = (): never => {
            throw new Error('data.documents_scan: invalid cursor');
        };
        if (
            after.length < 21 ||
            after.length > 4137 ||
            after[0] !== 1 ||
            !after.subarray(1, 17).equals(binding) ||
            after[20] !== 0
        )
            invalid();
        bucket = after.readUInt16LE(17);
        const flags = after[19];
        if (bucket > 255 || flags > 3) invalid();
        let pos = 21;
        if (flags !== 0) {
            if (after.length < pos + 16 || after[pos] !== bucket) invalid();
            const h = after.subarray(pos, pos + 16);
            pos += 16;
            if (flags === 1) afterHash = h;
            else hash = h;
        }
        if (flags === 3) {
            if (after.length < pos + 4) invalid();
            const n = after.readUInt32LE(pos);
            pos += 4;
            if (n > 4096 || after.length !== pos + n) invalid();
            afterKey = after.subarray(pos);
            pos += n;
        }
        if (pos !== after.length) invalid();
    }
    const prefix = collection + '\0';
    const rows = Array.from(records)
        .filter(([key]) => key.startsWith(prefix))
        .map(([sk, value]) => {
            const key = Buffer.from(sk.slice(prefix.length), 'latin1');
            const hash = createHash('sha256').update(prefix).update(key).digest().subarray(0, 16);
            return { sk, key, value, hash };
        })
        .sort((a, b) => Buffer.compare(a.hash, b.hash) || Buffer.compare(a.key, b.key));
    const entries: typeof rows = [];
    let frameBytes = 5;
    for (let probe = 0; probe < 8 && bucket < 256 && entries.length < limit; probe++) {
        if (probe > 0) chargeDbReadProbe(db);
        if (hash === null) {
            const next = rows.find(
                (row) =>
                    row.hash[0] === bucket &&
                    (afterHash === null || Buffer.compare(row.hash, afterHash) > 0),
            );
            if (next === undefined) {
                bucket++;
                afterHash = null;
                afterKey = null;
            } else {
                hash = next.hash;
                afterHash = null;
                afterKey = null;
            }
            continue;
        }
        const currentHash = hash;
        const row = rows.find(
            (row) =>
                row.hash.equals(currentHash) &&
                (afterKey === null || Buffer.compare(row.key, afterKey) > 0),
        );
        if (row === undefined) {
            afterHash = hash;
            hash = null;
            afterKey = null;
            continue;
        }
        const entryBytes = 12 + row.key.length + row.value.length;
        if (frameBytes + entryBytes + 45 + row.key.length > dbBudgetSnapshot(db).maxResultBytes) {
            if (entries.length === 0)
                throw new Error('TDL021: document scan entry exceeds result budget');
            break;
        }
        entries.push(row);
        frameBytes += entryBytes;
        afterKey = row.key;
    }
    const writer = new DataWriter().writeU32(entries.length);
    for (const row of entries)
        writer
            .writeBytes(row.key)
            .writeU32(versions.get(row.sk) ?? 0)
            .writeBytes(row.value);
    writer.writeU8(bucket < 256 ? 1 : 0);
    if (bucket < 256) {
        const flags = hash !== null ? (afterKey !== null ? 3 : 2) : afterHash !== null ? 1 : 0;
        const cursor = new DataWriter().writeU8(1);
        for (const byte of binding) cursor.writeU8(byte);
        cursor.writeU16(bucket).writeU8(flags).writeU8(0);
        const cursorHash = hash ?? afterHash;
        if (cursorHash !== null) {
            for (const byte of cursorHash) cursor.writeU8(byte);
        }
        if (afterKey !== null) cursor.writeBytes(afterKey);
        writer.writeBytes(cursor.toBytes());
    }
    return Buffer.from(writer.toBytes());
}

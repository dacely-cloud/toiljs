import { DataReader } from './codec.js';

export interface DeriveMetadata {
    readonly deriveId: number;
    readonly dbName: string;
    readonly methodName: string;
}

/** Stable identity shared by host control queues; UTF-8 length, not UTF-16 length. */
export function deriveIdentity(entry: Pick<DeriveMetadata, 'dbName' | 'methodName'>): string {
    return `${new TextEncoder().encode(entry.dbName).length}:${entry.dbName}${entry.methodName}`;
}

/** Decode the bounded toildb.derives section for build checks and host dispatch. */
export function readDeriveCatalog(section: Uint8Array): readonly DeriveMetadata[] | null {
    if (section.length > 128 * 1024) return null;
    const r = new DataReader(section);
    if (r.readU16() !== 1) return null;
    const count = r.readU16();
    if (!r.ok || count > 1024) return null;
    const entries: DeriveMetadata[] = [];
    const ids = new Set<number>(),
        names = new Set<string>();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
        for (let i = 0; i < count; i++) {
            const deriveId = r.readU16();
            const db = r.readBytes(),
                method = r.readBytes();
            if (
                !r.ok ||
                db.length === 0 ||
                db.length > 1024 ||
                method.length === 0 ||
                method.length > 1024
            )
                return null;
            const entry = {
                deriveId,
                dbName: decoder.decode(db),
                methodName: decoder.decode(method),
            };
            const identity = deriveIdentity(entry);
            if (ids.has(deriveId) || names.has(identity)) return null;
            ids.add(deriveId);
            names.add(identity);
            entries.push(entry);
        }
    } catch {
        return null;
    }
    return r.ok && r.remaining() === 0 ? entries : null;
}

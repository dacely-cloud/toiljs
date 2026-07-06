/**
 * Parse a compiled server wasm's `toildb.catalog` custom section into structured
 * dev capability metadata keyed by `"<Db>/<collection>"` (the resolve key the
 * guest passes to `data.resolve_collection`).
 *
 * The dev DB uses this to STAMP each write with the value type's current schema
 * version. When the developer evolves a `@data` type and rebuilds, the catalog
 * version changes; data already on disk keeps its OLD stamp, so a read surfaces
 * that old version and the guest's woven `decodeInto` runs the `@migrate` - the
 * dev-side equivalent of the edge binding the cap's schema_version into the row.
 * The parsed family is also used to reject wrong-family imports locally.
 *
 * Wire format mirrors `toildb::catalog` / the backend `db_catalog` decoder and the
 * compiler's `buildToilDbCatalog` emitter (all little-endian).
 */

import { DataReader } from 'toiljs/io';
import { customSection } from '../wasm/sections.js';
import {
    CollectionFamily,
    type DbCatalogState,
    DEFAULT_FILL_WAIT_MS,
    type DevCollectionHandle,
    type DevField,
    isCollectionFamily,
    MAX_FILL_WAIT_MS,
} from './types.js';

function validReplication(value: number): boolean {
    return value === 0 || value === 1 || value === 2 || value === 5;
}

function validPlacement(value: number): boolean {
    return value === 0 || value === 1;
}

/** Decode the devserver's catalog state. A missing section stays distinct from a
 *  present-but-bad section so `resolve_collection` can match the edge's
 *  Present/Malformed/NoSection admission behavior. */
export function parseCatalog(wasm: Buffer): DbCatalogState {
    const collections = new Map<string, DevCollectionHandle>();
    let sec: Buffer | null;
    try {
        sec = customSection(wasm, 'toildb.catalog');
    } catch {
        return { kind: 'no-section' }; // garbage section table (mid-rebuild) -> no catalog
    }
    if (sec === null) return { kind: 'no-section' };

    const r = new DataReader(sec);
    const version = r.readU16();
    if (!r.ok || version !== 1) return { kind: 'malformed' };
    const ndb = r.readU16();
    for (let d = 0; d < ndb && r.ok; d++) {
        const db = r.readString();
        const nc = r.readU16();
        for (let c = 0; c < nc && r.ok; c++) {
            const name = r.readString();
            const family = r.readU8();
            r.readString(); // keyType
            r.readString(); // valueType
            r.readU32(); // valueDataId
            const schemaVersion = r.readU32();
            r.readU32(); // generation
            const replication = r.readU8(); // emitter order: replication then placement
            const placement = r.readU8();
            const fillMaxWaitMs = r.readU32();
            const fillAllowStaleByte = r.readU8();
            if (
                fillMaxWaitMs > MAX_FILL_WAIT_MS ||
                (fillAllowStaleByte !== 0 && fillAllowStaleByte !== 1)
            )
                return { kind: 'malformed' };
            const fillAllowStale = fillAllowStaleByte === 1;
            const nFields = r.readU16();
            const fields: DevField[] = [];
            for (let f = 0; f < nFields; f++) {
                const fName = r.readString();
                const fType = r.readString();
                const isArray = r.readU8() !== 0;
                const unique = r.readU8() !== 0;
                fields.push({ name: fName, typeName: fType, isArray, unique });
            }
            const nMig = r.readU16();
            for (let m = 0; m < nMig; m++) r.readU32(); // migratableFrom versions
            if (
                !isCollectionFamily(family) ||
                !validReplication(replication) ||
                !validPlacement(placement)
            )
                return { kind: 'malformed' };
            const key = db + '/' + name;
            if (collections.has(key)) return { kind: 'malformed' };
            if (r.ok)
                collections.set(key, {
                    name: key,
                    family: family as CollectionFamily,
                    schemaVersion: schemaVersion >>> 0,
                    replication,
                    placement,
                    fillMaxWaitMs,
                    fillAllowStale,
                    fields,
                });
        }
    }
    if (!r.ok || r.remaining() !== 0) return { kind: 'malformed' };
    return { kind: 'present', collections };
}

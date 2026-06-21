/**
 * Parse a compiled server wasm's `toildb.catalog` custom section into a map of
 * `"<Db>/<collection>"` (the resolve key the guest passes to
 * `data.resolve_collection`) -> the collection's CURRENT `schema_version`.
 *
 * The dev DB uses this to STAMP each write with the value type's current schema
 * version. When the developer evolves a `@data` type and rebuilds, the catalog
 * version changes; data already on disk keeps its OLD stamp, so a read surfaces
 * that old version and the guest's woven `decodeInto` runs the `@migrate` - the
 * dev-side equivalent of the edge binding the cap's schema_version into the row.
 *
 * Wire format mirrors `toildb::catalog` / the backend `db_catalog` decoder and the
 * compiler's `buildToilDbCatalog` emitter (all little-endian).
 */

/** Read a LEB128 from `buf` at `pos`; throws on overrun (the section is a
 *  tenant-built, possibly mid-rebuild wasm, so it must never over-read). */
import { DataReader } from 'toiljs/io';

function leb(buf: Buffer, pos: number): [number, number] {
    let result = 0;
    let shift = 0;
    let p = pos;
    for (;;) {
        if (p >= buf.length) throw new RangeError('leb128 past end of buffer');
        const b = buf[p++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) throw new RangeError('leb128 too long');
    }
    return [result >>> 0, p];
}

/** The bytes of the named wasm custom section, or null if absent. Bounds-checked
 *  so a truncated/garbage module can never read past the buffer. */
function customSection(wasm: Buffer, want: string): Buffer | null {
    let pos = 8; // skip the 8-byte magic + version header
    while (pos < wasm.length) {
        const id = wasm[pos++];
        let size: number;
        [size, pos] = leb(wasm, pos);
        const end = pos + size;
        if (end > wasm.length || end < pos) return null; // truncated section table
        if (id === 0) {
            let nameLen: number;
            let namePos: number;
            [nameLen, namePos] = leb(wasm, pos);
            if (namePos + nameLen <= end && wasm.toString('latin1', namePos, namePos + nameLen) === want)
                return wasm.subarray(namePos + nameLen, end);
        }
        pos = end;
    }
    return null;
}

/** `"<Db>/<collection>"` -> current `schema_version` for every collection. Decoded
 *  with the shared bounds-checked {@link DataReader} (it returns 0/empty + flips
 *  `.ok` past the end), so a truncated/garbage section - e.g. a mid-rebuild wasm -
 *  yields only the collections that decoded cleanly and never over-reads. Mirrors
 *  the compiler's `buildToilDbCatalog` emitter + the backend `db_catalog` decoder. */
export function parseCatalog(wasm: Buffer): Map<string, number> {
    const out = new Map<string, number>();
    let sec: Buffer | null;
    try {
        sec = customSection(wasm, 'toildb.catalog');
    } catch {
        return out; // garbage section table (mid-rebuild) -> no catalog
    }
    if (sec === null) return out;

    const r = new DataReader(sec);
    r.readU16(); // catalog format version
    const ndb = r.readU16();
    for (let d = 0; d < ndb && r.ok; d++) {
        const db = r.readString();
        const nc = r.readU16();
        for (let c = 0; c < nc && r.ok; c++) {
            const name = r.readString();
            r.readU8(); // family
            r.readString(); // keyType
            r.readString(); // valueType
            r.readU32(); // valueDataId
            const schemaVersion = r.readU32();
            r.readU32(); // generation
            r.readU8(); // replication (emitter order: replication then placement)
            r.readU8(); // placement
            const nFields = r.readU16();
            for (let f = 0; f < nFields; f++) {
                r.readString(); // field name
                r.readString(); // field type
                r.readU8(); // isArray
            }
            const nMig = r.readU16();
            for (let m = 0; m < nMig; m++) r.readU32(); // migratableFrom versions
            if (r.ok) out.set(db + '/' + name, schemaVersion >>> 0);
        }
    }
    return out;
}

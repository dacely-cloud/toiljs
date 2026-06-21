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

function leb(buf: Buffer, pos: number): [number, number] {
    let result = 0;
    let shift = 0;
    let p = pos;
    for (;;) {
        const b = buf[p++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
    }
    return [result >>> 0, p];
}

/** The bytes of the named wasm custom section, or null if absent. */
function customSection(wasm: Buffer, want: string): Buffer | null {
    let pos = 8; // skip the 8-byte magic + version header
    while (pos < wasm.length) {
        const id = wasm[pos++];
        let size: number;
        [size, pos] = leb(wasm, pos);
        const end = pos + size;
        if (id === 0) {
            let nameLen: number;
            let namePos: number;
            [nameLen, namePos] = leb(wasm, pos);
            if (wasm.toString('latin1', namePos, namePos + nameLen) === want)
                return wasm.subarray(namePos + nameLen, end);
        }
        pos = end;
    }
    return null;
}

/** `"<Db>/<collection>"` -> current `schema_version` for every collection. */
export function parseCatalog(wasm: Buffer): Map<string, number> {
    const out = new Map<string, number>();
    const sec = customSection(wasm, 'toildb.catalog');
    if (sec === null) return out;
    let pos = 0;
    const u8 = () => sec[pos++];
    const u16 = () => {
        const v = sec.readUInt16LE(pos);
        pos += 2;
        return v;
    };
    const u32 = () => {
        const v = sec.readUInt32LE(pos);
        pos += 4;
        return v;
    };
    const str = () => {
        const n = u32();
        const s = sec.toString('latin1', pos, pos + n);
        pos += n;
        return s;
    };
    try {
        u16(); // catalog format version
        const ndb = u16();
        for (let d = 0; d < ndb; d++) {
            const db = str();
            const nc = u16();
            for (let c = 0; c < nc; c++) {
                const name = str();
                u8(); // family
                str(); // keyType
                str(); // valueType
                u32(); // valueDataId
                const schemaVersion = u32();
                u32(); // generation
                u8(); // placement
                u8(); // replication
                const nFields = u16();
                for (let f = 0; f < nFields; f++) {
                    str(); // field name
                    str(); // field type
                    u8(); // isArray
                }
                const nMig = u16();
                for (let m = 0; m < nMig; m++) u32(); // migratableFrom versions
                out.set(db + '/' + name, schemaVersion >>> 0);
            }
        }
    } catch {
        // A truncated/old section: return whatever decoded cleanly (dev tolerance).
    }
    return out;
}

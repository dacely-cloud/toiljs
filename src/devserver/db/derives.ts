import { customSection } from '../wasm/sections.js';

/**
 * Parses the `toildb.derives` wiring section emitted by toilscript for a
 * `@database` class with `@derive` materializer methods (see the compiler's
 * `buildToilDbDerives`). It maps each derive to its owning `@database` class, so
 * the dev runtime (`runtime/module.ts`) can, after a dispatch writes a source
 * collection, re-run that database's derives under FunctionKind=Derive. Fails
 * closed: any malformed byte yields `[]` (no derive runs) rather than throwing.
 *
 * Section layout (LE), mirroring `buildToilDbDerives`:
 *   u16 format_version = 1
 *   u16 n_derives
 *   per derive: u16 derive_id, str db_name, str method_name   (str = u32 len + bytes)
 */
export interface DeriveEntry {
    readonly deriveId: number;
    readonly dbName: string;
    readonly methodName: string;
}

const SECTION = 'toildb.derives';
const VERSION = 1;
const MAX_SECTION_BYTES = 128 * 1024;
const MAX_DERIVES = 1024;
const MAX_NAME_BYTES = 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function parseDerives(wasm: Buffer): readonly DeriveEntry[] {
    let section: Buffer | null;
    try {
        section = customSection(wasm, SECTION);
    } catch {
        return [];
    }
    if (section === null) return [];
    if (section.length > MAX_SECTION_BYTES) return [];

    const r = new Reader(section);
    const version = r.u16();
    if (!r.ok || version !== VERSION) return [];
    const count = r.u16();
    if (!r.ok || count > MAX_DERIVES) return [];

    const derives: DeriveEntry[] = [];
    for (let i = 0; i < count && r.ok; i++) {
        const deriveId = r.u16();
        const dbName = r.string();
        const methodName = r.string();
        if (!r.ok || dbName.length === 0) return [];
        derives.push({ deriveId, dbName, methodName });
    }
    if (!r.ok || r.remaining() !== 0) return [];
    return derives;
}

/**
 * The derives whose owning `@database` had at least one source collection
 * written during this dispatch. `written` holds "Db/coll" store keys; the
 * database is the prefix before the first `/`. Each affected derive appears at
 * most once (coalescing: many writes to one database run its derives once).
 */
export function derivesForWrites(
    derives: readonly DeriveEntry[],
    written: ReadonlySet<string>,
): readonly DeriveEntry[] {
    if (derives.length === 0 || written.size === 0) return [];
    const dbs = new Set<string>();
    for (const key of written) {
        const slash = key.indexOf('/');
        dbs.add(slash >= 0 ? key.slice(0, slash) : key);
    }
    return derives.filter((d) => dbs.has(d.dbName));
}

class Reader {
    private pos = 0;
    ok = true;

    constructor(private readonly bytes: Buffer) {}

    remaining(): number {
        return this.bytes.length - this.pos;
    }

    u16(): number {
        if (!this.ok || this.pos + 2 > this.bytes.length) {
            this.ok = false;
            return 0;
        }
        const out = this.bytes.readUInt16LE(this.pos);
        this.pos += 2;
        return out;
    }

    u32(): number {
        if (!this.ok || this.pos + 4 > this.bytes.length) {
            this.ok = false;
            return 0;
        }
        const out = this.bytes.readUInt32LE(this.pos);
        this.pos += 4;
        return out;
    }

    string(): string {
        const len = this.u32();
        if (!this.ok || len > MAX_NAME_BYTES || this.pos + len > this.bytes.length) {
            this.ok = false;
            return '';
        }
        try {
            const out = UTF8_DECODER.decode(this.bytes.subarray(this.pos, this.pos + len));
            this.pos += len;
            return out;
        } catch {
            this.ok = false;
            return '';
        }
    }
}

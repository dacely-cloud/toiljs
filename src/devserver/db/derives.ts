import { readDeriveCatalog, deriveIdentity, type DeriveMetadata } from 'toiljs/io';
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
export type DeriveEntry = DeriveMetadata;

/** Length-framed identity; the numeric id is only a dispatcher index. */
export function deriveCheckpointKey(entry: DeriveEntry): string {
    return JSON.stringify([entry.dbName, entry.methodName]);
}
export const deriveContinuationKey = deriveIdentity;

export function parseDerives(wasm: Buffer): readonly DeriveEntry[] {
    try {
        const section = customSection(wasm, 'toildb.derives');
        return section === null ? [] : (readDeriveCatalog(section) ?? []);
    } catch {
        return [];
    }
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

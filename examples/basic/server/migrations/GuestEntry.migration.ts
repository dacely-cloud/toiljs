/**
 * A ToilDB data MIGRATION for the guestbook's `GuestEntry` (see ../models/GuestEntry).
 *
 * THE CONVENTION: every `@migrate` lives in a `*.migration.ts` file under a
 * `migrations/` folder (enforced at compile time). The build auto-discovers this
 * file - nothing imports it - and weaves its transform into `GuestEntry`'s decoder.
 *
 * THE STORY: `GuestEntry` started life with just `author` + `message`. Later we
 * added an `at` timestamp. Without a migration, every entry already written would
 * fail to decode (its bytes have no `at`). With this file, an OLD entry is decoded
 * as its original shape and upgraded on READ - lazily, per row, only when touched.
 * No backfill, no downtime: rows written under the old layout keep working, and a
 * read rewrites the converged value back so it is paid for at most once.
 *
 * Try it under `toiljs dev`: sign the guestbook, then add a field to `GuestEntry`
 * + extend this transform + rebuild. The entries already on disk (in `.toil/`)
 * surface their OLD schema_version, so this `@migrate` runs when you `list()` them.
 */

import { GuestEntry } from '../models/GuestEntry';

/** The ORIGINAL `GuestEntry` layout (v1): no `at` timestamp. Kept so entries on
 *  disk written under it still decode. One kept shape per past layout. */
@data
export class GuestEntryV1 {
    author: string = '';
    message: string = '';
}

/**
 * Upgrade a v1 entry to the current `GuestEntry`. The DELTA form `(old, into)`
 * auto-copies the fields the two layouts SHARE (`author`, `message`); we only fill
 * the field that is new. A migration is a PURE transform - it may not touch the
 * database (that is a compile error).
 */
@migrate
export function up(old: GuestEntryV1, into: GuestEntry): void {
    into.at = 0; // unknown for pre-timestamp entries
}

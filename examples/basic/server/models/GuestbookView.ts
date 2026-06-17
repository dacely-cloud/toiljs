import { GuestEntry } from './GuestEntry';

/** The guestbook snapshot returned by the routes: the running signature count
 *  plus the most-recent entries (newest first). A `@data` wrapper so the
 *  `GuestEntry[]` round-trips through the codec. */
@data
export class GuestbookView {
    total: i64 = 0;
    entries: GuestEntry[] = [];
}

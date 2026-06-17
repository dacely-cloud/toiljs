import { Counter, Events } from 'toildb';

import { GuestEntry } from '../models/GuestEntry';
import { GuestbookView } from '../models/GuestbookView';
import { NewMessage } from '../models/NewMessage';

/**
 * A PERSISTENT guestbook, mounted at `/guestbook`, backed by ToilDB.
 *
 * The contrast with `Players` (whose comment notes "memory resets next request")
 * is the whole point: every signature is appended to an `events` stream and
 * tallied in a `counter`, so the data SURVIVES across requests under `toiljs dev`
 * (the in-process ToilDB emulator) and runs on ScyllaDB at the edge - same code,
 * no connection string. On the client:
 *
 *   await Server.REST.guestbook.sign({ body: new NewMessage('Ada', 'hi!') });
 *   const book = await Server.REST.guestbook.list(); // { total, entries: [...] }
 */

// The guestbook is one global stream; a single fixed key addresses it.
@data
class GuestKey {
    room: string = 'main';
    constructor(room: string = 'main') {
        this.room = room;
    }
}

@database
class GuestbookDb {
    @collection entries!: Events<GuestEntry, GuestKey>;
    @collection totals!: Counter<GuestKey>;
}

/** The current total + the 10 newest entries. */
function snapshot(): GuestbookView {
    const key = new GuestKey('main');
    const view = new GuestbookView();
    view.total = GuestbookDb.totals.get(key);
    view.entries = GuestbookDb.entries.latest(key, 10);
    return view;
}

@rest('guestbook')
class Guestbook {
    /** `GET /guestbook` - the running total + the most recent signatures. */
    @get('/')
    public list(): GuestbookView {
        return snapshot();
    }

    /** `POST /guestbook` - append a signature (PERSISTED) and return the
     *  updated book. Sign twice and the total keeps climbing across requests. */
    @post('/')
    public sign(input: NewMessage): GuestbookView {
        const key = new GuestKey('main');
        const at = <u64>(Date.now() / 1000);
        GuestbookDb.entries.append(key, new GuestEntry(input.author, input.message, at));
        GuestbookDb.totals.add(key, 1);
        return snapshot();
    }
}

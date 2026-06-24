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
 *
 * Reading the newest entries is a SCAN (`events.latest`), which is barred in a
 * request handler (a `@get` runs as a Query, a `@post` as an Action) because a
 * scan can fan out across unbounded rows. So a `@derive` does the scan off the
 * request path and `publish`es a materialized `GuestbookView`; the GET then
 * serves that view with a single non-scan `view.get`.
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
    @collection static entries: Events<GuestKey, GuestEntry>;
    @collection static totals: Counter<GuestKey>;
    // The materialized snapshot the GET serves: total + newest entries.
    @collection static book: View<GuestKey, GuestbookView>;

    /**
     * Recompute the materialized view from the source of truth (the event log +
     * the counter). The runtime runs this under FunctionKind=Derive after a
     * signature is appended (and rebuilds it when a box first loads), so the
     * scan (`events.latest`) and the `view.publish` - both barred in a request
     * handler - are allowed here. This is also where `GuestEntry`'s `@migrate`
     * fires: `events.latest` decodes each stored event at ITS schema version, so
     * an old pre-`at` entry is migrated as the view is rebuilt.
     */
    @derive
    recompute(): void {
        const key = new GuestKey('main');
        const view = new GuestbookView();
        view.total = GuestbookDb.totals.get(key);
        view.entries = GuestbookDb.entries.latest(key, 10);
        GuestbookDb.book.publish(key, view);
    }
}

@rest('guestbook')
class Guestbook {
    /** `GET /guestbook` - the running total + the most recent signatures, served
     *  from the materialized view (a non-scan `view.get`). */
    @get('/')
    public list(): GuestbookView {
        const key = new GuestKey('main');
        const view = GuestbookDb.book.get(key);
        if (view == null) return new GuestbookView();
        return view;
    }

    /** `POST /guestbook` - append a signature (PERSISTED) and acknowledge with
     *  the new running total. The entries list is served by the GET above from
     *  the view the `@derive` republishes right after this action. Sign twice
     *  and the total keeps climbing across requests. */
    @post('/')
    public sign(input: NewMessage): GuestbookView {
        const key = new GuestKey('main');
        const at = <u64>(Date.now() / 1000);
        GuestbookDb.entries.append(key, new GuestEntry(input.author, input.message, at));
        GuestbookDb.totals.add(key, 1);
        const view = new GuestbookView();
        view.total = GuestbookDb.totals.get(key); // Counter get: non-scan, action-legal
        return view;
    }
}

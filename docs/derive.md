# Derive (materialized views)

`@derive` precomputes a read-optimized **view** from your data so reads stay
fast and never scan. A request handler (`@get` runs as a *query*, `@post`/`@put`/
`@delete` as an *action*) is not allowed to scan, reading "the latest N events"
or "every member of a set" could fan out across unbounded rows, so those scans
are barred on the request path. A `@derive` does the scan **off** the request
path: it folds your event log / counters into a `View`, and your route serves
that view with a single keyed read.

```ts
@database
class GuestbookDb {
  @collection static entries: Events<GuestKey, GuestEntry>;
  @collection static totals: Counter<GuestKey>;
  @collection static book: View<GuestKey, GuestbookView>;

  // Recompute the view from the sources. Runs after a signature is written
  // (and when a box first loads). A derive MAY scan + publish; a route may not.
  @derive
  recompute(): void {
    const key = new GuestKey('main');
    const view = new GuestbookView();
    view.total = GuestbookDb.totals.get(key);      // counter read
    view.entries = GuestbookDb.entries.latest(key, 10); // scan, allowed here
    GuestbookDb.book.publish(key, view);           // publish the materialized view
  }
}
```

## Why a derive

ToilDB gates every data op by the *function kind* it runs under:

- **query** (`@get`/`@head`) and **action** (`@post`/`@put`/`@patch`/`@delete`)
  may do keyed reads and (actions only) writes, but **not scans**
  (`events.latest`, `membership.list`).
- **derive** may do everything a read can, **plus** scans, plus
  `view.publish`/`append`/`counter.add`.

So if a page needs "the 10 newest entries" or "the leaderboard", you cannot read
that directly in the `@get`. Instead a `@derive` builds it once into a `View`,
and the `@get` reads the view by key, which is not a scan.

## Declaring a derive

A derive is a method on your `@database` class, alongside the collections it
reads and the `View` it writes:

```ts
@database
class MyDb {
  @collection static events: Events<Key, Fact>;   // a source
  @collection static home: View<Key, HomePage>;    // the materialized view

  @derive
  rebuild(): void {
    // read sources, build the value, publish it
  }
}
```

Rules:

- A `@derive` method takes **no arguments and returns `void`**.
- A `@database` may declare **multiple** `@derive` methods; each is run
  independently.
- The view value (`HomePage` above) and the key are ordinary `@data` types, so
  they round-trip through the codec like any other stored value.

## `View<K, V>`

A `View` is a published, read-optimized projection. Its API:

```ts
view.get(key)       // V | null   - the published view, or null if none yet
view.require(key)   // V          - like get, but traps if nothing is published
view.publish(key, value) // void  - overwrite the view (derive/job only)
```

`publish` is only allowed from a `@derive` (or a `@job`); the host assigns the
version so a later publish always supersedes an earlier one. `get`/`require` are
plain keyed reads, allowed from any handler, including a `@get` route.

## When derives run

You never call a derive yourself. The runtime runs it for you:

- **After a write to a source.** When a request writes one of a database's
  source collections (an `events.append`/`append_once`, a `counter.add`, or a
  record `create`/`patch`), that database's derives run right after the response
  is produced, so the view reflects the new data on the next read. Many writes to
  one database in a single request coalesce into one recompute.
- **On box load.** When a server box starts or hot-reloads (or the underlying
  source data changed out of band), the views are rebuilt from their sources
  before the first read is served. This is also where a value type's `@migrate`
  runs against old stored events, as the derive re-reads and republishes them.

A derive's own writes (its `view.publish`) never re-trigger it.

The same code runs under `toiljs dev` (the in-process emulator) and on the
production edge, no flags or wiring to change.

## Reading a view from a route

The route just reads the view by key, which is a non-scan read and so is legal in
a `@get`:

```ts
@rest('guestbook')
class Guestbook {
  @get('/')
  list(): GuestbookView {
    const key = new GuestKey('main');
    const view = GuestbookDb.book.get(key);
    return view == null ? new GuestbookView() : view; // empty until first publish
  }

  @post('/')
  sign(input: NewMessage): GuestbookView {
    const key = new GuestKey('main');
    GuestbookDb.entries.append(key, new GuestEntry(input.author, input.message, 0));
    GuestbookDb.totals.add(key, 1);
    // The @derive republishes `book` right after this action returns, so the
    // entries list is served by GET. The action just acks with the new total
    // (a counter read is allowed here; a scan is not).
    const view = new GuestbookView();
    view.total = GuestbookDb.totals.get(key);
    return view;
  }
}
```

## How it fits together (the guestbook)

The `examples/basic` guestbook is the end-to-end demo:

1. `POST /guestbook` (an action) appends the signature to an `Events` stream and
   bumps a `Counter`. It returns the running total, but it does **not** read the
   entry list (that would be a scan).
2. The runtime then runs `@derive recompute()` under the derive kind: it scans
   `entries.latest(...)`, reads the `totals` counter, and `publish`es a fresh
   `GuestbookView`.
3. `GET /guestbook` (a query) reads `book.get(...)`, a single keyed read, and
   returns the precomputed total + newest entries.

Sign twice and the total climbs across requests, because the data lives in
ToilDB (and its view), not in module memory.

## Notes

- A derive **recomputes** the view from whatever its method reads (here, the
  latest 10 events). It is a fresh recompute on each trigger, so it suits views
  built from a bounded read (latest N, a counter total, a small set). Folding an
  unbounded full event log incrementally is a separate, more advanced pattern.
- Because publishes are last-writer-wins and a derive recomputes from the source
  of truth, a view always converges to a correct snapshot of its sources.
- See also: [`data.md`](data.md) for `@data` value types, and the ToilDB host
  ABI for the exact `derive_run` / `toildb.derives` contract.

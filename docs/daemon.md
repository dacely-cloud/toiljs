# Daemon

`@daemon` declares a single, leader-elected background worker for your domain -
the **L4** (global) coordination tier of the Toil edge. Where a `@rest` handler
is a fresh instance per request and a `@stream` box is one instance per
connection, there is exactly **one** daemon per domain at a time. The edge keeps
a warm standby ready and fails over at-most-once, so the daemon is the right
place for work that must happen once globally rather than once per request.

```ts
@daemon
class Jobs {
  @scheduled('1h')
  hourly(): void {
    // Runs once an hour on the elected leader. Put recurring background work
    // here (rollups, cleanup, polling an upstream, ...).
  }
}
```

## `@daemon` classes

`@daemon` marks a class as the domain's background worker. The class is resident:
it is created once on the elected leader and lives for as long as that leader
holds the lease, so its fields persist across scheduled runs (a `@rest`
handler's fields would reset every request).

Exactly one daemon instance runs per domain at any moment. A second node stays a
warm standby and only becomes active if the current leader's lease lapses. You do
not start, stop, or place the daemon yourself - the edge elects the leader and
drives it.

## `@scheduled`

A `@scheduled` method declares a task that fires on a cadence, always on the
**elected leader**. The single string argument is the cadence:

```ts
@scheduled('1h')
hourly(): void { /* ... */ }
```

- **Interval strings** like `'1h'` fire on that fixed period.
- **Cron expressions** are also supported when you need a wall-clock schedule
  rather than a fixed interval.

A class can declare several `@scheduled` methods; each runs on its own cadence.
Because only the leader fires them, a task runs once per domain per tick, not
once per node.

## The daemon entry

The daemon surface has its own entry module, `server/main.daemon.ts`. It imports
the `@daemon` classes so the compiler-generated `daemon_start` / `scheduled_tick`
exports are pulled into the artifact:

```ts
// server/main.daemon.ts
import { revertOnError } from 'toiljs/server/runtime/abort/abort';

import './daemon/Jobs';

// The abort hook (the daemon box reports a trap through it). NOTE: unlike main.ts /
// main.stream.ts, the daemon entry does NOT re-export the request runtime - a cold
// artifact exposes daemon_start/scheduled_tick, not the request `handle`.
export function abort(message: string, fileName: string, line: u32, column: u32): void {
  revertOnError(message, fileName, line, column);
}
```

Note what is **not** here: unlike `main.ts` and `main.stream.ts`, the daemon
entry does not `export * from 'toiljs/server/runtime/exports'`. A daemon (cold)
artifact exposes `daemon_start` and `scheduled_tick`, not the request `handle`.
Add a daemon as you grow by importing its module here.

## Build

`toiljs build` runs one toilscript pass per tier and hands each pass only the
entries that belong to it. When the project declares a `@daemon` / `@scheduled`
surface, the daemon pass compiles `server/main.daemon.ts` into its own artifact,
`build/server/release-cold.wasm`:

```sh
$ ls build/server/*.wasm
build/server/release.wasm          # L1 request    (exports: handle)
build/server/release-stream.wasm   # L2/L3 stream   (exports: stream_dispatch)
build/server/release-cold.wasm     # L4 daemon      (exports: daemon_start, scheduled_tick)
```

So `release.wasm` never contains `scheduled_tick` and the daemon artifact never
contains the request `handle`. Plain `@data` and helper modules are shared into
every artifact. See [Tiers](./tiers.md) for how the three artifacts are produced
from one source tree.

## Use cases

The daemon is the once-per-domain tier, so it fits work you want to happen
globally on a cadence rather than per request:

- **Periodic rollups** - aggregate counters or events into summaries.
- **Cleanup** - expire stale rows, prune logs, reclaim resources.
- **Polling an upstream** - pull from an external API on a schedule.
- **Global coordination** - any task that must run exactly once across the
  domain, not once per node.

## Failover

Scheduling is **at-most-once**. A `@scheduled` task fires on whichever node
currently holds the leader lease. If that leader fails, the warm standby takes
over and fires the **subsequent** runs; the edge does not retry or duplicate the
tick that was in flight when the leader was lost. This trades exactly-once
delivery for the guarantee that two nodes never run the same scheduled tick at
once, so design tasks to be safe to skip an occasional run and to be idempotent
where a missed run matters.

---

See also:

- [Tiers](./tiers.md) - the three deployment tiers and how one source tree
  compiles to a separate artifact per tier.
- [Streams](./streams.md) - the L2/L3 `@stream` tier (one resident box per
  connection).

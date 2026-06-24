# toiljs streams example

A [toiljs](https://toil.org) app that showcases the **three deployment tiers** of the Toil
edge - one source tree, compiled into a **separate WebAssembly artifact per tier**, each with
a different lifetime and placement.

| Entry (`server/`)  | Surface                          | Artifact                           | Tier  | Lifetime / placement                                            |
| ------------------ | -------------------------------- | ---------------------------------- | ----- | --------------------------------------------------------------- |
| `main.ts`          | `@rest` / `@service` / `@remote` | `build/server/release.wasm`        | **L1** request   | A fresh handler per request, anywhere on the edge.       |
| `main.stream.ts`   | `@stream`                        | `build/server/release-stream.wasm` | **L2/L3** stream | One **resident box per connection**, pinned to a worker via QUIC connection-id steering; its state survives every event. |
| `main.daemon.ts`   | `@daemon` / `@scheduled`         | `build/server/release-cold.wasm`   | **L4** daemon    | Exactly **one leader-elected box per domain** (warm standby, at-most-once failover) firing `@scheduled` tasks. |

`toiljs build` runs one toilscript pass per tier, handing each pass only the entries that belong
to it, so `release.wasm` never contains `stream_dispatch` and the daemon artifact never contains
the request `handle`. Plain `@data`/helper modules are shared into every artifact.

## What's in here

- `server/main.ts` + `server/core/AppHandler.ts` - the **L1** request surface (serves this app).
- `server/main.stream.ts` + `server/streams/Echo.ts` - an **L2/L3** `@stream` mounted at `/echo`.
  The `count` field on `Echo` persists across `@connect`/`@message`/`@close` because the box is
  resident for the whole connection (a `@rest` handler's fields would reset each request).
- `server/main.daemon.ts` + `server/daemon/Jobs.ts` - an **L4** `@daemon` with an hourly
  `@scheduled` task that runs on the elected leader.

## Develop

    npm install
    npm run dev

## Build

    npm run build

Then look at the three artifacts the single build produced:

    $ ls build/server/*.wasm
    build/server/release.wasm          # L1 request    (exports: handle)
    build/server/release-stream.wasm   # L2/L3 stream   (exports: stream_dispatch)
    build/server/release-cold.wasm     # L4 daemon      (exports: daemon_start, scheduled_tick)

## Note on the `@stream` message bridge

The stream lifecycle (`@connect`/`@message`/`@close`/`@disconnect`) runs today, and this example
proves a resident box keeps state across those events. Reading the inbound frame bytes and replying
(the `StreamPacket` / `StreamOutbound` API, plus the typed `Server.STREAM.echo.connect()` client) is
the next increment - see the comments in `server/streams/Echo.ts`.

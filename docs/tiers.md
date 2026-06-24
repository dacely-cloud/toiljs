# Deployment tiers

A Toil app's server runs across several deployment **tiers** from one source
tree. Each tier has a different lifetime and placement on the edge, and compiles
into its own WebAssembly artifact. You write one project; `toiljs build` decides
which entries belong to which tier and emits one `.wasm` per tier. You opt into a
tier purely by adding its entry file and surface decorator; nothing else changes.

## The tiers

| Entry (`server/`) | Surface | Artifact | Tier | Lifetime / placement |
| --- | --- | --- | --- | --- |
| `main.ts` | `@rest` / `@service` / `@remote` | `build/server/release.wasm` | **L1** request | A fresh handler per request, anywhere on the edge. |
| `main.stream.ts` | `@stream` | `build/server/release-stream.wasm` | **L2/L3** stream | One resident box per connection, pinned to a worker via QUIC connection-id steering; its state survives every event. See [Streams](./streams.md). |
| `main.daemon.ts` | `@daemon` / `@scheduled` | `build/server/release-cold.wasm` | **L4** daemon | Exactly one leader-elected box per domain (warm standby, at-most-once failover) firing `@scheduled` tasks. See [Daemon](./daemon.md). |

The three tiers differ in how long a box lives and how many of it exist:

- **L1 request** is stateless. A `@rest` handler's fields reset each request,
  because a fresh box serves each one, anywhere on the edge.
- **L2/L3 stream** is resident per connection. A `@stream` box is created when a
  connection opens, lives for its lifetime, and is torn down on close, so its
  fields persist across every event.
- **L4 daemon** is a single elected leader per domain - the global coordination
  tier - running recurring background work on a cadence.

## How the build works

`toiljs build` runs one toilscript pass per tier, handing each pass only the
entries that belong to it. Tier membership is decided by the surface decorator or
by the entry naming convention:

- a runtime-export entry that is **not** `*.stream.ts` or `*.daemon.ts` is the
  **request** entry (`main.ts`), which compiles `@rest` / `@service` / `@remote`;
- `*.stream.ts` is the **stream** entry, which compiles `@stream`;
- `*.daemon.ts` is the **daemon** entry, which compiles `@daemon` / `@scheduled`.

Plain `@data` and helper modules carry no tier of their own, so they are shared
into every artifact. Routing each entry to exactly one tier is what keeps
`release.wasm` free of `stream_dispatch` and keeps the daemon artifact free of
the request `handle`.

Each entry is a thin file that imports its tier's modules and re-exports the
right runtime hooks. The stream and request entries re-export the request runtime
exports; the daemon entry does not, because a cold artifact exposes
`daemon_start` / `scheduled_tick`, not `handle`:

```ts
// server/main.stream.ts - the L2/L3 stream entry
import { revertOnError } from 'toiljs/server/runtime/abort/abort';
import './streams/Echo';

export * from 'toiljs/server/runtime/exports';
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
```

```ts
// server/main.daemon.ts - the L4 daemon entry
import { revertOnError } from 'toiljs/server/runtime/abort/abort';
import './daemon/Jobs';

// NOTE: no `export *` from the request runtime - a cold artifact exposes
// daemon_start/scheduled_tick, not the request `handle`.
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
```

A single build produces the artifacts side by side:

```sh
$ ls build/server/*.wasm
build/server/release.wasm          # L1 request    (exports: handle)
build/server/release-stream.wasm   # L2/L3 stream   (exports: stream_dispatch)
build/server/release-cold.wasm     # L4 daemon      (exports: daemon_start, scheduled_tick)
```

## Single-artifact default

A project with no `@stream` and no `@daemon` surface keeps the legacy
single-artifact build - just `build/server/release.wasm`. The stream and daemon
tiers are opt-in: add `main.stream.ts` (and a `@stream` class) to get
`release-stream.wasm`, add `main.daemon.ts` (and a `@daemon` class) to get
`release-cold.wasm`. Existing request-only apps build exactly as before.

## When to use each tier

- **L1 request** for request/response and RPC: `@rest` controllers, `@service` /
  `@remote` callable surface. The default tier; most code lives here.
- **L2/L3 stream** for stateful, long-lived connections where per-connection
  state must survive across events - the resident box is pinned to one worker for
  the connection's lifetime.
- **L4 daemon** for scheduled and coordination work: rollups, cleanup, polling an
  upstream, anything that should run exactly once per domain on a cadence rather
  than per request.

```ts
// server/streams/Echo.ts - L2/L3: the box is resident, so `count` persists.
@stream('echo')
class Echo {
    private count: i32 = 0;

    @connect onConnect(): void { this.count = 0; }
    @message onMessage(): void { this.count = this.count + 1; }
    @close   onClose(): void { /* box torn down after this hook */ }
}
```

```ts
// server/daemon/Jobs.ts - L4: one leader per domain runs this hourly.
@daemon
class Jobs {
    @scheduled('1h')
    hourly(): void {
        // Recurring background work: rollups, cleanup, polling an upstream, ...
    }
}
```

## See also

- [Streams](./streams.md) - the `@stream` surface and the L2/L3 tier.
- [Daemon](./daemon.md) - the `@daemon` surface and the L4 tier.
- [Routing](./routing.md) - `@rest` controllers on the L1 request tier.
- [RPC](./rpc.md) - `@service` / `@remote` and the generated client.

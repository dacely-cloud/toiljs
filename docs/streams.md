# Streams

A `@stream` declares a long-lived, stateful protocol handler over WebTransport -
the **L2/L3** (regional / continental) stream tier of the Toil edge. Unlike a
`@rest` route, which is a fresh handler per request, a `@stream` is a **resident
WebAssembly box per connection**: it is created when the connection opens, lives
for the whole connection, and is torn down on close. State stored on its fields
**persists across events**, because it is the same box every time.

```ts
@stream('echo')
class Echo {
  private count: i32 = 0;

  @connect
  onConnect(): void {
    this.count = 0;
  }

  @message
  onMessage(): void {
    this.count = this.count + 1;
  }

  @close
  onClose(): void {}
}
```

## Declaring a stream

`@stream(name)` marks a class as a stream handler and mounts it at the given
name/route. The class becomes a resident box; its fields are the connection's
state.

```ts
@stream('echo')            // mounted at /echo
class Echo { /* ... */ }
```

A stream lives on the **L2/L3 stream tier** and its default scope is **Regional
(L2)**. See [Tiers](./tiers.md) for the full tier model.

## Lifecycle hooks

A stream method is a lifecycle hook, chosen by its decorator. All hooks are
optional - declare only the ones you need; a missing hook is a no-op.

| Decorator | Fires when |
| --- | --- |
| `@connect` | the connection opens (the box has just been created). |
| `@message` | an inbound frame arrives. |
| `@close` | the connection closes gracefully (the box is torn down after this hook). |
| `@disconnect` | the transport is lost abruptly. |
| `@channel` | an opt-in distributed channel delivers a message (advanced; see below). |

The `Echo` example above shows why state survives: `count` is set to `0` in
`@connect`, incremented on every `@message`, and the increments **accumulate**.
That is only possible because the same resident box handles every event for the
connection. A `@rest` handler's fields would reset on each request, since a
fresh handler is constructed per request.

`@channel` is an opt-in **distributed** channel (advanced) - a way for boxes to
exchange messages beyond a single connection. It is mentioned here for
completeness; most streams use only the four connection-lifecycle hooks.

## Placement

A `@stream` is distributed across the eligible L2/L3 stream nodes and pinned to
**ONE worker** for the connection's lifetime via QUIC connection-id steering. The
connection always lands on the same worker, so the box - and the state on its
fields - survives every event. You do not manage placement; the edge steers each
connection to its resident box automatically.

## The entry: `main.stream.ts`

The stream surface has its own entry, `server/main.stream.ts`, distinct from the
request entry (`server/main.ts`). It re-exports the WASM runtime exports and
imports the `@stream` classes, which pulls their compiler-generated
`stream_dispatch` export into the artifact.

```ts
import { revertOnError } from 'toiljs/server/runtime/abort/abort';

import './streams/Echo';

// Re-export the WASM entry points the host binds, exactly like main.ts.
export * from 'toiljs/server/runtime/exports';
export function abort(message: string, fileName: string, line: u32, column: u32): void {
  revertOnError(message, fileName, line, column);
}
```

This entry compiles into its **own artifact**, `build/server/release-stream.wasm`
- the resident stream box - separate from the request build,
`build/server/release.wasm`. Add a stream as you grow by importing it here:

```ts
import './streams/Echo';
```

## Build

`toiljs build` produces `release-stream.wasm` automatically when the project
declares a `@stream` surface. The single build runs one toilscript pass per tier,
handing each pass only the entries that belong to it, so `release.wasm` never
contains `stream_dispatch` and the stream artifact never contains the request
`handle`. Plain `@data` and helper modules are shared into every artifact.

```sh
$ toiljs build
$ ls build/server/*.wasm
build/server/release.wasm          # L1 request   (exports: handle)
build/server/release-stream.wasm   # L2/L3 stream  (exports: stream_dispatch)
build/server/release-cold.wasm     # L4 daemon     (exports: daemon_start, scheduled_tick)
```

See [Tiers](./tiers.md) for how the three artifacts map to the deployment tiers.

## Reading and replying to messages

`@message` receives the inbound frame as a `StreamPacket` and returns a
`StreamOutbound`. `StreamPacket.bytes()` is the raw frame payload;
`StreamOutbound.reply(bytes)` stages one frame back to the client (return an empty
`StreamOutbound` to accept the frame without replying). The same resident box
handles every frame, so state on its fields persists across messages.

```ts
@message
reply(packet: StreamPacket): StreamOutbound {
  return StreamOutbound.reply(packet.bytes());   // echo the bytes back
}
```

## Typed messages

By default a `@message` payload is **raw bytes**. Opt into a decoded `@data` value
with `@stream({ message: T })`: the `@message` hook then receives the named `@data`
class, decoded from the frame for you. The reply stays raw (`StreamOutbound`).

```ts
@data
class ChatMsg { text: string = ''; }

@stream({ message: ChatMsg })
class Chat {
  @message
  onMessage(msg: ChatMsg): StreamOutbound {       // decoded @data, not raw bytes
    return StreamOutbound.reply(new TextEncoder().encode(msg.text));
  }
}
```

## The client

A `@stream` class is reachable from the browser as `Server.Stream.<ClassName>`. The
typed client is generated into `shared/server.ts` (the same place `Server.REST`
lands), so no manual wiring is needed. `connect()` opens a WebSocket to the class's
route and resolves a channel:

```ts
const chat = await Server.Stream.Chat.connect();
chat.onMessage((bytes) => { /* a reply frame, always raw bytes */ });
chat.send(new ChatMsg('hello'));   // a typed stream: send() encodes the @data for you
chat.onClose((code) => { /* a 0x02xx stream close code */ });
chat.close();
```

- The channel key is the **class name** (`Server.Stream.Chat`); it connects to the
  class's mount route (`/Chat`).
- A **raw** `@stream` channel sends `Uint8Array`; a **typed** `@stream({ message: T })`
  channel sends the `@data` class and encodes it on the wire for you.
- The inbound reply is **always raw bytes** - the server's `StreamOutbound` is raw.
- `connect()` resolves once the upgrade completes; a `@connect` reject (or any
  later server close) surfaces through `onClose(code)`.

---

See also: [Tiers](./tiers.md), [Daemon](./daemon.md), [Routing](./routing.md).

# Streams (`@stream`)

A `@stream` is a server class that handles one live connection from start to finish. You mark a class with `@stream`, add lifecycle hooks, and the Dacely edge keeps one instance of that class alive for as long as the browser stays connected.

## What a stream is (and why it is different)

When you write an [HTTP route](../backend/rest.md), the server builds a **fresh** handler for every request and throws it away afterward. Anything you stored on the handler's fields is gone the moment the response is sent. That is perfect for one-shot requests, but it means the handler cannot "remember" anything between requests on its own.

A `@stream` is the opposite. It is a **resident box**: one live instance, created when a connection opens and kept alive until it closes. Because it is the *same* instance for every message on that connection, values you store on its fields **persist across messages**. That is what makes it the right tool for a conversation, a game session, or anything stateful that lasts for the life of a connection.

The word "resident" just means "stays in memory and keeps running." The word "box" is toiljs's name for one sandboxed instance of your compiled server code.

```ts
@stream('echo')
class Echo {
    private count: i32 = 0;

    @connect
    onConnect(): void {
        this.count = 0; // a fresh connection starts a fresh box, so count begins at 0
    }

    @message
    onMessage(packet: StreamPacket): StreamOutbound {
        this.count = this.count + 1; // survives across messages: same box every time
        const text = 'pong #' + this.count.toString();
        return StreamOutbound.reply(Uint8Array.wrap(String.UTF8.encode(text)));
    }

    @close
    onClose(): void {
        // the box is destroyed after this hook runs
    }
}
```

Connect, send three messages, and you get back `pong #1`, `pong #2`, `pong #3`. The advancing number is proof that the same box handled all three.

## Declaring a stream

Mark a class with `@stream` and give it a **name**. The name becomes the route the browser connects to.

```ts
@stream('echo')       // mounted at /echo
class Echo { /* ... */ }

@stream                // bare form: the route is the class name (/Echo)
class Echo { /* ... */ }
```

There are three forms:

- `@stream('name')`: an explicit mount name (connect at `/name`).
- `@stream` (bare): the mount name is the class name.
- `@stream({ ... })`: a config object (see [Configuration](#configuration) below).

## The four lifecycle hooks

A stream method becomes a lifecycle hook when you tag it with one of these decorators. Every hook is **optional**: declare only the ones you need, and a missing hook is simply a no-op (it does nothing, it never crashes).

| Decorator     | Fires when...                                                            |
| ------------- | ----------------------------------------------------------------------- |
| `@connect`    | the connection opens (the box has just been created).                   |
| `@message`    | an inbound frame arrives from the browser.                              |
| `@close`      | the connection closes cleanly (the box is destroyed after this hook).   |
| `@disconnect` | the connection is lost abruptly (network dropped, browser killed).      |

A **frame** is one message: one call to `send()` on the client becomes one `@message` on the server.

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as @stream box
    B->>S: open
    activate S
    Note over S: @connect runs, box is created
    B->>S: frame "a"
    S-->>B: @message -> reply
    B->>S: frame "b"
    S-->>B: @message -> reply
    B->>S: close
    Note over S: @close runs, box is destroyed
    deactivate S
```

### `@connect`

Runs once, right after the box is created. Use it to set up per-connection state (reset a counter, read the requested path, decide whether to accept the connection). It can return a `StreamOutbound` to accept or reject (see below). The Echo example uses it to zero its counter.

**What it receives.** `@connect` is handed a `StreamInbound`, a small read-only object the host fills in with the details of the connection that just opened. It lets you look at *where* the connection came from before you decide to keep it.

| Member        | Type     | What it gives you                                                       |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `streamId`    | `u64`    | A unique id for this connection.                                        |
| `transport`   | `i32`    | A numeric tag for the transport that carried the connection.           |
| `authority()` | `string` | The host the browser connected to (for example `example.com`).         |
| `path()`      | `string` | The path the browser opened (for example `/echo`).                     |

Watch the shape: `authority()` and `path()` are **methods** (call them with `()`), while `streamId` and `transport` are plain properties (no parentheses).

```ts
@connect
onConnect(info: StreamInbound): StreamOutbound {
    // Inspect where the connection is headed, then decide whether to keep it.
    if (info.path() != '/echo') {
        return StreamOutbound.reject(1);   // refuse: any u16 reason code
    }
    this.count = 0;                        // fresh connection, fresh state
    return StreamOutbound.accept();        // keep the connection open
}
```

You do not have to take the argument. If the hook needs none of these details, declare it with no parameter (`onConnect(): void`), exactly like the Echo example above.

### `@message`

Runs for every inbound frame. This is where most of your logic lives. It receives the frame and may reply. Details in [Reading and replying](#reading-and-replying-to-messages).

### `@close` and `@disconnect`

Both mean "the connection is over," and both are your chance to clean up. The difference is *how* it ended:

- `@close` is a **graceful** close: the browser (or your server) ended it on purpose.
- `@disconnect` is an **abrupt** loss: the network dropped or the tab was killed with no goodbye.

After either one, the box is destroyed.

**What they receive.** Both hooks are handed a `StreamConnectionEvent`, a read-only summary of the connection that just ended.

| Member         | Type  | What it gives you                                          |
| -------------- | ----- | ---------------------------------------------------------- |
| `connectionId` | `u64` | The id of the connection that ended.                       |
| `reason`       | `u16` | A numeric close code explaining why it ended.              |
| `durationMs`   | `u64` | How long the connection stayed open, in milliseconds.      |

All three are plain properties (getters), so read them without `()`.

```ts
@close
onClose(ev: StreamConnectionEvent): void {
    // Last chance to clean up. `ev` tells you how the connection ended.
    const heldSeconds = ev.durationMs / 1000;
    // e.g. record the session length or flush a buffer here.
}

@disconnect
onDisconnect(ev: StreamConnectionEvent): void {
    // Same shape, but this fired because the connection dropped abruptly.
    // ev.reason carries the close code the edge assigned to the drop.
}
```

As with `@connect`, the argument is optional: declare `onClose(): void` if you do not need it.

## Per-connection state (and its limits)

State on the box's fields lasts for **one connection**. It does **not** survive:

- a **reconnect**: if the browser drops and reopens, it gets a brand-new box that starts clean.
- a **different user**: every connection gets its own box, so one connection's state can never leak into another. This is a safety property, not just a convenience.

So treat box fields as **per-connection scratch space** only. For anything that must outlive the connection (a saved message, a score, who a user is across reconnects), write it to [the database](../database/README.md), not to a class field.

## Reading and replying to messages

By default, a `@message` receives a `StreamPacket`, which is a thin view over the raw bytes that arrived, and returns a `StreamOutbound`, which stages the reply.

```ts
@message
onMessage(packet: StreamPacket): StreamOutbound {
    const raw = packet.bytes();               // the inbound frame as bytes
    return StreamOutbound.reply(raw);          // echo the same bytes back
}
```

`StreamPacket` (the inbound frame):

| Member       | What it gives you                                           |
| ------------ | ---------------------------------------------------------- |
| `bytes()`    | the whole frame as a `Uint8Array` (copy it if you keep it). |
| `length`     | the number of bytes in the frame.                          |
| `at(i)`      | the byte at index `i`.                                     |

`StreamOutbound` (what you return):

| Call                          | Meaning                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `StreamOutbound.reply(bytes)` | send one frame back to the browser.                                |
| `StreamOutbound.empty()`      | accept the frame and send nothing back.                            |
| `StreamOutbound.reject(code)` | refuse (used from `@connect` to turn a connection away).           |
| `StreamOutbound.accept()`     | accept a connection with no reply frame.                           |

A `@message` may also return `void` when it never replies.

> **Bytes, not strings.** A frame is raw bytes on the wire. To send text, encode it with `String.UTF8.encode(...)` (server) or `new TextEncoder().encode(...)` (browser), and decode it with `new TextDecoder().decode(...)` on the other side.

### Typed messages

Raw bytes are flexible but fiddly. If your messages are structured, declare a [`@data`](../backend/data.md) class and pass it as the stream's `message` type. Your `@message` hook then receives the **decoded object** instead of raw bytes.

```ts
@data
class ChatMsg {
    text: string = '';
    constructor(text: string = '') { this.text = text; }
}

@stream({ message: ChatMsg })
class Chat {
    @message
    onMessage(msg: ChatMsg): StreamOutbound {          // decoded @data, not raw bytes
        const echoed = 'you said: ' + msg.text;
        return StreamOutbound.reply(Uint8Array.wrap(String.UTF8.encode(echoed)));
    }
}
```

The reply is still raw (`StreamOutbound` deals in bytes). Only the **inbound** side is decoded for you. On the client, a typed stream lets you `send(new ChatMsg('hi'))` and toiljs encodes it for you.

## Games and interactive apps

A stream box remembers state for the life of a connection, which is exactly what a game session needs. Each connected player gets their **own** box, and that box holds the player's live state (position, health, score) in memory, right next to the core handling their packets. The lifecycle hooks map cleanly onto a session: `@connect` spawns the player, `@message` handles each input, `@close` and `@disconnect` remove them.

```ts
// server/streams/Match.ts
@data
class Move {                          // the input a player sends each tick
    dx: i32 = 0;
    dy: i32 = 0;
    constructor(dx: i32 = 0, dy: i32 = 0) { this.dx = dx; this.dy = dy; }
}

@stream({ message: Move, scope: StreamScope.Regional })
class Match {
    // Per-connection state: this player's position. It lives in memory for the
    // whole session, on the one core that owns this connection.
    private x: i32 = 0;
    private y: i32 = 0;
    private moves: u32 = 0;

    @connect
    onConnect(info: StreamInbound): StreamOutbound {
        this.x = 50;                  // spawn point
        this.y = 50;
        this.moves = 0;
        return StreamOutbound.accept();
    }

    @message
    onMove(move: Move): StreamOutbound {
        // Apply the input to this player's live position, then confirm it.
        this.x = this.x + move.dx;
        this.y = this.y + move.dy;
        this.moves = this.moves + 1;
        const state = '{"x":' + this.x.toString() + ',"y":' + this.y.toString() + '}';
        return StreamOutbound.reply(Uint8Array.wrap(String.UTF8.encode(state)));
    }

    @disconnect
    onDrop(ev: StreamConnectionEvent): void {
        // The player left (tab closed, network died). Their box is destroyed
        // next. Persist a score here if it must outlive the session.
    }
}
```

Every input a player sends is one `@message`, applied to **their** box's position and confirmed straight back to them with low latency. Because the box is resident, the player's position is always there in memory, on the same core, with no database round trip per move. That is what makes fast input loops (a game tick, a cursor drag, a live editor) feel instant.

**What this version does, and does not, do.** Each player has their own box, so this handles per-player input, per-player state, and instant confirmation back to that player. To make players see **each other** (the other half of multiplayer), one player's move must fan out to everyone else in the match. That cross-connection broadcast is the `@channel` feature, which is **planned, not live yet** (see [Channels](./channels.md)). Until it ships, the common patterns are to write shared match state to [the database](../database/README.md) and have clients read it, or to keep a match to a single authoritative box. The per-connection pieces above (input, state, and presence via `@connect` / `@disconnect`) work today.

For **presence** ("who is online"), `@connect` and `@disconnect` are your join and leave signals: bump a counter or write a row when a player connects, and undo it when they drop.

## The `main.stream.ts` file (a separate tier)

Streams live in their **own entry file**, `server/main.stream.ts`, separate from the request entry `server/main.ts`. Importing your `@stream` classes there pulls them into a **separate compiled artifact**, `build/server/release-stream.wasm`.

```ts
// server/main.stream.ts
import { revertOnError } from 'toiljs/server/runtime/abort/abort';

import './streams/Echo'; // add each @stream module here as you grow
import './streams/Chat';

// Re-export the WASM entry points the host binds, exactly like main.ts.
export * from 'toiljs/server/runtime/exports';
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
```

Why a separate file? A stream box and a request handler are **different kinds of program** that run on different parts of the edge (see [Compute tiers](../concepts/tiers.md)). toiljs compiles each into its own `.wasm`:

```sh
$ toiljs build
$ ls build/server/*.wasm
build/server/release.wasm          # L1 request   (@rest / @service)
build/server/release-stream.wasm   # L2/L3 stream  (@stream)
build/server/release-cold.wasm     # L4 daemon     (@daemon)
```

You do not run this by hand. `toiljs build` produces `release-stream.wasm` automatically whenever your project has a `@stream` surface, and shared helper code and `@data` types are compiled into every artifact.

> **One file cannot be both a stream and an RPC surface.** A single source file may not declare both a `@stream` and a `@service` / `@remote` ([RPC](../backend/rpc.md)), because one compiled artifact cannot be two tiers at once. Keep them in separate files: `@stream` in `main.stream.ts`, `@rest` / `@service` in `main.ts`. They coexist happily side by side in the same project, just not in the same file.

## Configuration

The config-object form lets you tune a stream:

```ts
@stream({
    scope: StreamScope.Regional,   // where the box runs (see below)
    message: ChatMsg,              // decode inbound frames into this @data type
    maxFrameBytes: 65536,          // reject frames larger than this
    ingressRingBytes: 262144       // size of the inbound buffer
})
class Chat { /* ... */ }
```

- **`scope`** picks how close to the user the box runs. `StreamScope.Regional` (the default) runs it at a regional node; `StreamScope.Continental` runs it at a wider continental node. See [Compute tiers](../concepts/tiers.md) for what L2 and L3 mean.
- **`message`** is the typed-message shortcut described above.
- **`maxFrameBytes`** and **`ingressRingBytes`** cap frame size and buffer size to protect the box from oversized or flooding input.

## Reaching a stream from the browser

Every `@stream` class gets a generated, typed client at `Server.Stream.<ClassName>`, wired up for you in `shared/server.ts` (the same place the [RPC](../backend/rpc.md) client lands). Call `connect()` to open the connection:

```ts
import '../shared/server'; // attaches globalThis.Server (browser-only)

const chat = await Server.Stream.Echo.connect();
chat.onMessage((bytes) => { /* a reply frame, always raw bytes */ });
chat.send(new TextEncoder().encode('hello'));
chat.onClose((code) => { /* the connection ended */ });
chat.close();
```

The client is keyed by the **class name** (`Server.Stream.Echo`) and connects to the class's **mount route** (`/echo`). Inbound replies are always raw bytes. The full client walkthrough, plus the lower-level `useChannel` hook, is in [Channels](./channels.md).

## How placement works (you do not manage it)

On the production edge, your box is pinned to **one worker** for the connection's whole life, using a QUIC feature called connection-id steering. In plain terms: every message from that connection is routed to the exact machine and process holding your box, so its in-memory state is always there. You never configure this; the edge does it automatically. In `toiljs dev` there is only one process, so this is a non-issue.

## Why this scales

A `@stream` box is deliberately cheap to run at scale, and the edge is built to spread a very large number of them across many cores and cities. Four design choices do the heavy lifting:

- **One core per connection, chosen by the connection id (CID-steering).** The edge encodes the owning worker core's id directly into the QUIC connection id (the label QUIC stamps on every packet), and authenticates it with a keyed tag so it cannot be forged. Every packet for your connection is routed to the one core holding your box. Connections spread across all cores, and there is no shared lock on the hot path: each core owns its own boxes in a plain per-core map. Adding cores adds capacity.
- **Kernel-bypass, multi-queue networking (DPDK).** The edge pulls packets from the network card in userspace, one worker per hardware queue, and the card fans arriving packets across those queues. Many cores handle traffic at once, in parallel, with no kernel socket in the middle to bottleneck on.
- **The connection survives network changes.** If a client's network changes (Wi-Fi to cellular, or a NAT rebind), a packet can arrive on the wrong core. The edge re-steers it to the owning core over a small lock-free per-core queue, and moves the box's key in lockstep so the box is never orphaned. The user keeps their session and their in-memory state.
- **Each box is isolated and bounded.** Every connection gets its own sandboxed box with its own linear memory. One tenant's boxes are capped to a slice of the node's RAM (a noisy-neighbor guard), and a single box is hard-capped (64 MiB) so a runaway connection can only fill itself, then it traps. Each lifecycle hook also runs under a per-event gas budget (a cap on how much work one event may do), so a hook that loops forever is stopped instead of hogging its core. (A finer per-packet gas policy is still being refined.)

Put together: connections spread across every core, cores run in parallel, the session sticks to its core even when the network moves, and each box is walled off from the others. That is what lets one deployment hold a very large number of live connections at once. How large depends on your hardware and message sizes; these docs do not publish a benchmarked number.

> **The wider picture.** For how CID-steering, the per-core re-steer queues, and the edge mesh add up to world-wide fan-out, see [Built for massive fan-out and world-wide sync](./README.md#built-for-massive-fan-out-and-world-wide-sync) in the overview.

## Gotchas

- **Box fields are per-connection only.** They reset on reconnect and are never shared between users. Persist anything durable to [the database](../database/README.md).
- **Frames are bytes.** Encode and decode text yourself, or use a typed `message` so toiljs does it.
- **Copy `packet.bytes()` if you keep it.** The inbound buffer is reused after the hook returns, so store a copy if you need the bytes later.
- **A file cannot mix `@stream` with `@service` / `@remote`.** Keep streams in `main.stream.ts`.
- **`@channel` is not live yet.** A stream that declares a `@channel` hook is rejected by the edge today. Broadcasting to many subscribers is a planned feature; see [Channels](./channels.md).

## Related

- [Realtime overview](./README.md): the big picture and when to reach for realtime.
- [Channels](./channels.md): the client `useChannel` hook and a chat-style example.
- [Compute tiers (L1 to L4)](../concepts/tiers.md): where the stream artifact runs.
- [Data types (`@data`)](../backend/data.md): typed messages.
- [The database (ToilDB)](../database/README.md): where to keep state that outlives a connection.

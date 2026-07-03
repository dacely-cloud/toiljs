# Realtime

Realtime is how your app pushes data to the browser the instant it happens, instead of the browser having to ask again and again. In toiljs you get realtime from two small pieces: a server class marked `@stream`, and a client React hook called `useChannel`.

## What "realtime" means

A normal web request is one round trip. The browser asks ("give me the todos"), the server answers, and the connection closes. If you want fresh data a second later, you have to ask again. That is fine for a page load or a form submit, but it is a poor fit for anything that changes on its own: a live chat, a game, a price ticker, a progress bar, a presence indicator ("3 people online").

Realtime flips it around. The browser opens **one long-lived connection** and keeps it open. After that, either side can send a message at any time, as many times as it likes, with no new handshake. That open connection is often called a **socket**.

## WebTransport in plain words

To hold that long-lived connection open, the browser and the Dacely edge speak a protocol called **WebTransport**.

Here is all you need to know as a beginner:

- WebTransport is a modern, built-in browser feature (like `fetch`, but for a persistent two-way connection).
- It runs on top of **HTTP/3** and **QUIC**, which are the newest, fastest versions of the web's plumbing. They are built for low latency (messages arrive quickly) and for surviving network changes (your phone switching from Wi-Fi to cellular without dropping the connection).
- You do not write any WebTransport code by hand. toiljs gives you a tiny client API, and it uses WebTransport underneath on the production edge.

One helpful detail for later: in local development (`toiljs dev`) the same client API runs over a **WebSocket** instead, because a WebSocket is simpler to serve from one local process. A WebSocket is the older, widely supported "keep a socket open" browser feature. The point is that **your code is identical** in dev and in production; only the transport underneath differs, and toiljs picks it for you.

## When to use realtime (and when not to)

Reach for realtime when **the server needs to talk first**, or when messages fly back and forth quickly:

| Use realtime when...                          | Use a plain HTTP request when...                 |
| --------------------------------------------- | ------------------------------------------------ |
| A chat or comment thread updates live.        | You load a page or a list once.                  |
| A game or drawing board syncs many moves.     | You submit a form and get one answer.            |
| You show live presence or typing indicators.  | You fetch data on a button click.                |
| You stream progress of a long job.            | The data rarely changes, or the user pulls it.   |

If a single request-and-response does the job, prefer that: it is simpler, it caches well, and it needs no open connection. Plain requests in toiljs are [HTTP routes](../backend/rest.md) and [typed RPC](../backend/rpc.md). Reach for realtime only when the "ask again and again" model genuinely gets in your way.

## The two pieces

Realtime in toiljs is always a pair:

1. **The server: a `@stream` class.** You write a small class and mark it `@stream`. The edge turns it into a **resident box**: a live instance that is created when a connection opens, handles every message on that connection, and is torn down when it closes. It has four lifecycle hooks (`@connect`, `@message`, `@close`, `@disconnect`). See [Streams](./streams.md).

2. **The client: a hook.** From your React UI you open the connection and send or receive messages. The low-level way is the `useChannel` hook; the typed, generated way is `Server.Stream.<ClassName>.connect()`. See [Channels](./channels.md).

```mermaid
sequenceDiagram
    participant B as Browser (React)
    participant E as Dacely edge
    participant S as Your @stream box
    B->>E: open connection (WebTransport, or WebSocket in dev)
    E->>S: create the box, run @connect
    Note over S: the box is now resident for this connection
    B->>E: send "hello"
    E->>S: @message("hello")
    S-->>B: reply "hi back"
    B->>E: send "still here"
    E->>S: @message("still here")
    S-->>B: reply "yep"
    B->>E: close
    E->>S: run @close, then destroy the box
```

Notice that the box lives across **many** messages in that diagram. That is the whole idea: because it is the same instance every time, it can remember things between messages (a counter, who you are, what room you joined). A normal HTTP handler forgets everything after each request; a stream box does not, for as long as the connection stays open.

## Where to go next

- [Streams](./streams.md): the server side. How to declare a `@stream` class, the four lifecycle hooks, per-connection state, replying, and the separate `main.stream.ts` file.
- [Channels](./channels.md): the client side. The `useChannel` React hook, the generated typed client, and a chat-style example. Also covers the planned `@channel` broadcast feature.

## Related

- [Compute tiers (L1 to L4)](../concepts/tiers.md): where a stream box runs on the edge.
- [HTTP routes (`@rest`)](../backend/rest.md) and [Typed RPC](../backend/rpc.md): the plain request-and-response alternatives.
- [Daemons](../background/daemons.md): long-lived background work that is not tied to a browser connection.

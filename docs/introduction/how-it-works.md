# How toil works

This page walks one app from source to response. What you write, what the build produces, and what happens when a request arrives. Every term is defined where it first appears. You configure none of the machinery below. This page just explains it.

## The client and the server

A toil app is one project. Your code lives in two folders.

- **`client/`** is a **React** frontend built with Vite. File-based routing, data loaders, the usual components. It runs in the user's browser.
- **`server/`** is your backend, written in **TypeScript with decorators**. Mark a class `@rest` for HTTP endpoints, `@service` for typed RPC, `@stream` for realtime, `@daemon` for background jobs, `@database` or `@collection` for stored data, `@auth` or `@user` for login. There are no servers to provision and no routes to wire by hand. The decorator is the wiring.

That is the whole surface. One repo, one language family, one `toiljs dev`.

## What the build produces

`toiljs build` turns that one project into three kinds of output. The browser and the edge need different things.

**The client bundle.** Your React app, plus any pages toil renders ahead of time. It ships as ordinary web files that run in the browser: HTML, JS, CSS, images. Every asset is fingerprinted with SHA-384 Subresource Integrity, so the browser refuses a file that was tampered with in transit.

**The server WASM.** Your `server/` backend, compiled by the **toilscript** compiler into a small sandboxed **WebAssembly** module. It runs on the edge, not in the browser and not in Node. The build emits three artifacts, one per compute tier.

| Artifact | Holds | Runs |
| --- | --- | --- |
| `release.wasm` | the hot request path (`@rest`, `@service`) | on every request |
| `release-stream.wasm` | realtime handlers (`@stream`) | for the life of a connection |
| `release-cold.wasm` | background and scheduled jobs (`@daemon`) | on a timer, worldwide-singleton |

**The generated typed client, `shared/server.ts`.** toil reads the shape of your backend and generates a small browser-side client from it. Your React code calls a normal async function, `Server.REST.*` or `Server.Stream.*` or `Server.<service>`, and the types line up end to end. Rename a field on the server and the frontend stops compiling until you fix it. No hand-written `fetch`, no drift.

A word on **WebAssembly**. It is a compact binary format that runs at close to native speed with no interpreter warm-up. It runs inside a **sandbox**: a locked box that cannot open files, reach the operating system, or make network calls on its own. The guest touches the outside world only through a small fixed set of functions the host hands it. Read the request, build a response, query the database. That narrow surface is what makes it safe to pack many apps onto one shared machine. ([Why that matters for scale](./hyperscale.md).)

toilscript is a strict TypeScript dialect: explicit value types, no `any`, no runtime `RegExp`. The [decorators reference](../concepts/decorators.md) covers the full set.

## The edge nodes

Your WASM does not run on a laptop or in one central data center. It runs on the **edge**: a fleet of Rust runtime nodes spread across many cities. Each user is served by whichever node is physically closest. There is no **origin server**, no single far machine every request funnels back to. Your backend and its data are already at the edge.

Two things make this work at the density it needs.

- **Multi-tenant on shared boxes.** Each app is a tiny sandboxed module, so one edge box safely runs many apps at once. That shared density is what makes putting compute near everyone affordable instead of a luxury.
- **A custom userspace datapath.** The node handles network packets itself in userspace, multi-queue, bypassing the operating system's network stack. This keeps the per-request cost low as traffic grows. **QUIC** and **WebTransport** ride on top to power realtime `@stream` connections.

## What happens on a request

A request never leaves the neighborhood. It lands on the nearest edge node, and everything happens right there.

```mermaid
sequenceDiagram
    participant U as User's browser
    participant E as Nearest edge node (Rust)
    participant W as WASM host
    participant G as Your guest module
    participant DB as ToilDB (local copy)

    U->>E: Request over the network
    alt Page or static asset
        E-->>U: Prerendered / SSR page or file
    else Dynamic API call
        E->>W: Decode raw bytes into a Request
        W->>G: Call your handler
        G->>DB: Read / write nearby data
        DB-->>G: Result
        G-->>W: Response object
        W-->>E: Encode to bytes
        E-->>U: Response
    end
```

1. **The request lands on the closest edge node.** The network routes the user there automatically.
2. **Page or dynamic call.** A prerendered page, a server-rendered page, or a static asset is served directly by the edge, which never wakes your backend. This is the fast path for most page loads.
3. **Otherwise the host runs your guest.** The **WASM host**, trusted Rust, decodes the raw bytes into a `Request`. It calls into your **guest module**, your sandboxed WASM, at its single entry point, which routes to the handler you wrote.
4. **Your handler reads and writes locally.** When it needs stored data it talks to [ToilDB](../database/README.md), which keeps a copy right there at the edge. No ocean crossing.
5. **Your handler returns a `Response`.** The host encodes it back to bytes and the edge sends it to the browser.

The mental model for your backend is a function of the request. Bytes in, bytes out, one request at a time.

### Why the backend is stateless

A fresh copy of your handler serves each request. The next request might land on a node on the other side of the planet, so anything you set on an instance field does not survive. This is deliberate. Interchangeable copies with nothing to coordinate are what let the backend scale worldwide by adding more nodes. When you need something to persist, write it to ToilDB. See the [backend overview](../backend/README.md#stateless-by-default).

## The database, ToilDB

State lives in [ToilDB](../database/README.md), toil's own database, replicated next to your code at the edge. It offers seven purpose-built families: Documents, Unique, Counter, Events, Membership, Capacity, View. You pick the shape that fits instead of forcing everything into one table.

The hard part is **distributed writes**. Every key has one **home region** that orders its writes, while the data replicates outward so reads stay fast and local everywhere. Most stacks distribute reads but pin writes to one region. toil is built to distribute both.

Where this stands today. The home-region model and its core logic are real and tested. A live multi-region deployment, meaning WAN routing over the ScyllaDB backing, is configuration-gated. It is not switched on for every app by default. A far read can also lag its home by a few milliseconds, the eventual-consistency trade-off. Your local `toiljs dev` database is a single in-process store. The [distributed writes page](./distributed.md) covers the write model and its trade-off in full.

## The four compute tiers

Not all backend code has the same lifespan. toil sorts it into four tiers, and the build assigns each piece from its decorator automatically.

| Tier | What runs here | Status |
| --- | --- | --- |
| **L1** | the stateless per-request hot path (`@rest`, `@service`) | live, the default |
| **L2 / L3** | longer-lived regional and continental work, `@stream` realtime | opt-in, deployment-gated |
| **L4** | a single worldwide `@daemon` for background and scheduled jobs | opt-in, deployment-gated |

Most apps live entirely on **L1**, which is real and running today. L2 through L4 are built and opt-in, not always-on for every app. Full detail is on the [tiers page](../concepts/tiers.md).

## The parts of a running app

Five parts make up a running toil app. You have now met all of them.

| Piece | What it is | Where it runs |
| --- | --- | --- |
| **React client** | your frontend UI, the client bundle from the build | the user's browser |
| **toilscript backend** | your `server/` code compiled to sandboxed WASM | the edge |
| **The edge node** | the Rust runtime that terminates the connection, serves pages, and runs your WASM | servers in many cities |
| **ToilDB** | the database with distributed writes, replicated next to your code | the edge |
| **The four tiers** | where and for how long a piece of backend code lives | L1 nearest, up to L4 worldwide |

None of these need configuring to get the good version. You write React and decorated TypeScript. The build, the edge, and the database come as the default, not a stack you assemble and babysit.

## Related

- [Backend overview](../backend/README.md): the request/response model and the sandbox in depth.
- [The database (ToilDB)](../database/README.md): families, home regions, and eventual consistency.
- [Compute tiers](../concepts/tiers.md): L1 request, L2/L3 stream, L4 daemon.
- [Realtime streams](../realtime/streams.md) and [background daemons](../background/daemons.md): the other two artifacts.
- [What makes toil hyper-scalable](./hyperscale.md): why this design serves the planet cheaply.

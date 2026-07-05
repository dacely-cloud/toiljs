# What makes toil hyper-scalable

Hyper-scale means serving very large worldwide traffic at low latency without rebuilding your app as it grows. Picture traffic climbing from a thousand users to a hundred million across every continent. Do you rewrite the system, or just run more of it?

Any stack can reach that scale if you spend enough: dedicated infrastructure per app, a rented vendor for each moving part, and an ops team to keep the seams from tearing. toil reaches the same scale from the other direction, cheaply. The whole design aims to make worldwide reach a default, not a budget line. This page is about cost.

## Why serving the whole world is normally expensive

Running near your users usually means paying in three places at once.

- **Dedicated infrastructure per app.** Each app gets its own boxes, its own containers, its own always-warm capacity. Spread that across many cities and you rent a lot of mostly-idle hardware.
- **A far-away origin.** Most stacks serve pages from everywhere but send anything real back to one origin in one region. Every write and every dynamic call pays for a round trip across the planet.
- **A centralized write database.** Reads scale out. Writes funnel into one primary in one city. That box is both the bottleneck and the thing you overprovision to stay ahead of.

These are cost multipliers, and they stack. toil removes all three.

## The three things that make toil cheap

Three mechanisms do the work, and they reinforce each other.

**1. Density: one box safely runs many apps.** Your backend compiles to its own tiny [sandboxed](./how-it-works.md#what-build-produces) WebAssembly module. It starts fast, runs at near-native speed, and cannot touch another tenant's files, memory, or network. Because the sandbox is that tight, one shared edge box holds many apps at once instead of one app per machine. That density is what makes running near everyone affordable. You are not renting dedicated hardware in fifty cities. You are one tenant on boxes that are already there and already busy.

**2. Edge locality: no trip to a central origin.** toil has no origin server. Every request runs on the [edge](../concepts/tiers.md) node nearest the user, on the per-request L1 hot path. The network hands the bytes to the WASM host, your handler runs, and the response goes back, all in one place. There is no slow hop to a faraway box to make the request real. Removing the origin removes both the latency and the standing cost of running one.

**3. Local reads, homed writes.** The data your handlers share lives in [ToilDB](../database/README.md), replicated outward so every edge node reads from a copy right next to it. Writes are not centralized. Every key has one home region that orders its writes, and the data replicates out for fast local reads. You get nearby reads everywhere without a single primary that every write funnels through, and without paying to overprovision one. The [distributed writes](./distributed.md) page covers the mechanism and its honest trade-off, eventual consistency.

```mermaid
flowchart LR
    subgraph Origin["The expensive shape: everything funnels to one origin"]
        direction TB
        A1["User (Tokyo)"] -->|slow| O[("Origin + DB<br/>(Virginia)")]
        A2["User (Paris)"] -->|slow| O
        A3["User (Sydney)"] -->|slow| O
    end
    subgraph Toil["The cheap shape: shared edge + homed writes"]
        direction TB
        B1["User (Tokyo)"] --> E1["Edge box + local data (Tokyo)"]
        B2["User (Paris)"] --> E2["Edge box + local data (Paris)"]
        B3["User (Sydney)"] --> E3["Edge box + local data (Sydney)"]
        E1 <-.->|"replicate"| E2
        E2 <-.->|"replicate"| E3
    end
```

The left side has one hot center every user drags a request to and back from, plus its dedicated fleet. No amount of caching removes that cost. The right side has no center and no per-app fleet. Add a city, add a shared box, and every tenant on it gets that city for near nothing.

## Why each mechanism lowers the cost

- **Density** splits the cost of an edge presence across many tenants instead of loading it on one app.
- **Edge locality** means no origin fleet to run and no cross-planet round trip on every real request.
- **No dedicated infrastructure** means you scale by adding interchangeable shared nodes, not by standing up a new stack per app.

Take any one away and a cost comes back. Without density, running near everyone is a luxury again. Without edge locality, you pay for an origin. With a centralized write path, the database caps you and gets overprovisioned to compensate.

## What is real today

This is the design, not a benchmark. Real throughput and latency depend on your hardware, where your users are, how your data is shaped, and how your handler is written. toil removes the central bottlenecks and keeps per-request cost low. It does not make a slow handler fast, and it does not repeal the speed of light between continents.

Some parts are honestly staged, not already everywhere.

- The per-request L1 edge path is live and real. The L2 regional, L3 continental, and L4 global-daemon tiers are opt-in and deployment-gated, not always-on for every app. See the [tiers page](../concepts/tiers.md).
- ToilDB's home-region write model and its core logic are real and tested. Live multi-cell deployment, meaning WAN routing and the ScyllaDB backing, is configuration-gated, not on by default. The local dev database is a single in-process store. [How toil is distributed](./distributed.md) is honest about what is finished.

## Related

- [How toil is distributed](./distributed.md): distributing the writes, the hard problem this rests on.
- [Compute tiers](../concepts/tiers.md): L1 through L4, and the stateless request model.
- [How toil works](./how-it-works.md): the build outputs and the request lifecycle.
- [The database (ToilDB)](../database/README.md): families, homes, and eventual consistency.
- [Why toil is built this way (the RSG bar)](./design-principles.md): the efficiency check behind the hot path.

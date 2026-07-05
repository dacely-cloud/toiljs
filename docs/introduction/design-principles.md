# Why toil is built this way (the RSG bar)

toil is opinionated on purpose, and the purpose is a single one: reach top-tier ("AAA") infrastructure, and ship it as the **default**. AAA-grade tech is normally something you assemble from a dozen vendors and babysit with a team that understands distributed systems. toil makes the good version the version you get out of the box, in one framework, with zero configuration. A solo builder starts from the same baseline as a funded team.

Every decision on this page traces back to that one goal. This page is the rubric toil holds itself against, and the principles that rubric forces.

## The bar: one grade, set by the weakest link

**RSG** (Resilience and Scale Grade) is toil's internal rubric for how resilient, distributed, fast, lean, and secure an app actually is, scored as a single letter from **AAA** down to **D**. It grades nine axes, and one rule runs the whole thing: **your grade is your weakest axis**, never the average and never the best. To earn AAA, all nine must be AAA at the same time.

A globally edged frontend on a single-region database is capped by the database. A worldwide system running slow code is capped by latency. The lowest column sets the grade, every time.

That rule exists to kill the most common lie in this space: calling a system "global scale" because the read path is global, while the write path is one box in one region. Averaging lets the strong axis hide the weak one. The minimum refuses to. RSG is not an external certification and no auditor issues it; it is a mirror the team holds up to find the weakest link and fix it first. The full rubric lives at the repository root in [`RSG.md`](../../RSG.md).

## The principles the bar forces

Aiming for AAA-as-default is not a slogan. It forces a specific handful of decisions, and they are the reason toil looks the way it does.

### 1. The good, safe, fast version is the default, not an upgrade

On most stacks the resilient path is a paid tier and the secure path is a checklist you get to later. toil inverts that: the strong version is what you get **before** you configure anything.

- **Post-quantum login in about one line.** Enable auth and a password is stretched through an OPRF (ristretto255) and Argon2id into a deterministic ML-DSA-44 keypair. Only the public key ever leaves the device, and login runs ML-KEM-768 mutual auth so the client verifies the server too. The password never reaches the server in a usable form. ML-DSA and ML-KEM are the NIST-standardized algorithms meant to survive a quantum computer. You do not assemble any of that; you switch it on.
- **Tamper-proofing is on, not opt-in.** Every shipped asset carries SHA-384 Subresource Integrity plus importmap integrity, so a modified script is rejected by the browser instead of run. Nothing to remember to turn on.

### 2. Batteries are included, and owned

Auth, [ToilDB](../database/README.md), email, rate limiting, analytics, realtime streaming, background jobs, materialized views, scheduled jobs, sessions and cookies, an environment and secrets store: all built and owned by toil, all first-party. That is not just convenience. It is the Dependencies axis, where zero third-party code on the critical path is what earns AAA. Nothing you cannot inspect or fix sits between a request and its response.

### 3. One framework, not ten vendors

You write a React frontend and a TypeScript backend in **one** project. toil runs both, plus the database, near your users worldwide. The browser calls the backend through a generated, fully typed `Server` client, so there is no hand-written fetch and no drift between the two halves. One project, one deploy, one mental model, instead of a frontend host plus an API host plus a database vendor plus an auth vendor plus a queue, each glued to the next.

### 4. Modern foundations, not legacy tooling

toil bets on current technology rather than propping up old tooling.

- **WebAssembly backends.** Your TypeScript compiles to a small, sandboxed WASM module. Because the sandbox is real, one edge box safely runs **many** tenants at once, and that multi-tenancy is exactly what makes running near everyone affordable.
- **Post-quantum crypto** as the login default (see principle 1), not classical crypto you swap out later.
- **End-to-end types** from the generated `Server` client, so a backend change that breaks the frontend is a compile error, not a production 500.
- **QUIC and WebTransport** carry realtime ([@stream](../concepts/tiers.md)).

### 5. Honesty about the limits

toil grades itself on honesty, so the docs and the product both state limits plainly rather than overclaim.

- **Distributed writes** are real in design and tested in the core: every key has one home region that orders its writes while data replicates outward for fast local reads (see [How toil is distributed](./distributed.md)). But live multi-region deployment is configuration-gated, not on by default, and the local dev database is a single in-process store. toil is **built** to distribute writes worldwide, and the mechanism is real; it is not the claim that every app is already running a live global write cluster today.
- **Compute tiers:** the per-request edge (L1) is live and real. Regional, continental, and global-daemon tiers are opt-in and deployment-gated, not always-on for every app.
- **Analytics** is real on the edge; the dev server returns sample data.
- **Auth secrets** ship as clearly-insecure dev placeholders so `toiljs dev` just works. A real deployment must set its own.
- toil is younger than the incumbents and its integration catalog is smaller. [vs other frameworks](./vs-other-frameworks.md) covers when not to reach for it.

## The bar in nine axes

Each axis names a way a system can be weak. Each row is the single design decision toil makes so that axis cannot be the thing that caps it.

| RSG axis | What it grades | The toil design choice that hits it |
| --- | --- | --- |
| **Topology + distribution** | How close your code runs to users, and in how many places | Edge compute: frontend and backend both run on nodes next to users, worldwide, not in one origin region. |
| **Availability** | What survives a failure | Cross-region failover with no single point of failure, so losing a node or a region does not take the app down. |
| **Data path** | Where data is read and *written* (the hard one) | ToilDB's per-key-home model distributes the **writes**, not just the reads. See [How toil is distributed](./distributed.md). |
| **Delivered p99 latency** | The end-to-end time the user actually feels | An allocation-free hot path, measured rather than assumed, so the response is fast for real, not just on paper. |
| **Program performance + architecture** | Hot-path code quality and cost per request (no brute-forcing latency with a big server bill) | No blocking work on the request path; speed comes from the code, not from overprovisioning. |
| **Dependencies** | How much of your critical path you own (zero third-party on it = AAA) | An owned, batteries-included stack: nothing third-party sits on the critical request path for you to be unable to inspect or fix. |
| **Security** | How hard the system is to break, and how bad a breach would be | Post-quantum password login, sandboxed WebAssembly backends, and Subresource Integrity on every asset. See [Security](../concepts/security.md). |
| **Client performance + reach** | How well the shipped app runs on old and low-end devices as data grows | A lean React client: a small bundle and linear-or-better hot paths, so it stays smooth on weak hardware, not just new flagships. |
| **Modern stack + compatibility** | Current foundations, *with* graceful fallback for older clients | WebAssembly backends, post-quantum auth, and QUIC/WebTransport realtime, negotiating down cleanly so a client one version behind still works. |

## The punchline

toil is opinionated because being AAA on **every** axis at once forces these choices, and it delivers them as the default so you do not have to earn each one by hand. You cannot reach the top grade with a fast frontend on a centralized database, or a global system running slow code, or a modern stack that only works on the newest browser. The weakest-link rule closes every one of those escape hatches. Any framework that lets a single axis slip is, by its own honest scoring, not AAA. Holding all nine at once, out of the box, is the whole reason toil looks the way it does.

## Related

- [How toil is distributed](./distributed.md): the data-path axis in depth, and why distributing writes is the hard one.
- [What makes toil hyper-scalable](./hyperscale.md): the topology, latency, and program axes in practice.
- [Security](../concepts/security.md): the security axis and its hard caps.
- [vs other frameworks](./vs-other-frameworks.md): the honest "when not to use toil".
- [`RSG.md`](../../RSG.md) at the repository root: the full rubric, the internal mirror this page summarizes.

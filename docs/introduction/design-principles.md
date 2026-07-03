# Why toil is built this way (the RSG bar)

toil is opinionated on purpose. Almost every design decision traces back to one internal rubric it
holds itself against, and this page shows the rubric and the choice each axis forces.

## The rubric in a paragraph

**RSG** (Resilience and Scale Grade) is toil's own internal rubric for how resilient, distributed,
fast, lean, and secure an app really is, scored as a single letter from AAA down to D. It grades
nine axes, and the one rule that matters is this: **your grade is your weakest axis**, never the
average and never the best. To earn AAA, all nine must be AAA at the same time. A globally edged
frontend on a single-region database is capped by the database. A worldwide system serving a
one-second app is capped by latency. The lowest column sets the grade, every time. RSG is not an
external certification and no auditor issues it; it is a design mirror the team holds up to find
the weakest link and fix it first. The full rubric lives at the repository root in
[`RSG.md`](../../RSG.md).

The reason for the weakest-link rule is the most common lie in this space: calling something
"global scale" because the read path is global, while the write path is one box in one region.
Averaging would let that one strong axis hide the weak one. The minimum refuses to.

## The nine axes, and the one choice each one forces

Each axis names a way a system can be weak. Each row is the single design decision toil makes so
that axis cannot be the thing that caps it.

| RSG axis | What it grades | The toil design choice that hits it |
| --- | --- | --- |
| **Topology + distribution** | How close your code runs to users, and in how many places | Edge compute: your frontend and backend both run on nodes next to users, worldwide, not in one origin region. |
| **Availability** | What survives a failure | Cross-region failover with no single point of failure, so losing a node or a region does not take the app down. |
| **Data path** | Where data is read and *written* (the hard one) | ToilDB's per-key-home model distributes the **writes**, not just the reads. See [How toil is distributed](./distributed.md). |
| **Delivered p99 latency** | The end-to-end time the user actually feels (measured, under 100ms = AAA) | An allocation-free hot path, measured rather than assumed, so the response is fast for real, not just on paper. |
| **Program performance + efficiency** | Hot-path code quality, and cost per request (no brute-forcing latency with a big server bill) | No blocking work on the request path; the fast path does no wasted work, so speed comes from the code, not from overprovisioning. |
| **Dependencies** | How much of your critical path you own (zero third-party on it = AAA) | An owned, batteries-included stack: nothing third-party sits on the critical request path for you to be unable to inspect or fix. |
| **Security** | How hard the system is to break, and how bad a breach would be | Post-quantum password login (the password never reaches the server in usable form), sandboxed WebAssembly backends, and Subresource Integrity on every asset. See [Security](../concepts/security.md). |
| **Client performance + reach** | How well the shipped app runs on old and low-end devices as data grows | A lean React client: a small bundle and linear-or-better hot paths, so it stays smooth on weak hardware, not just new flagships. |
| **Modern stack + compatibility** | Current protocols, *with* graceful fallback for older clients | HTTP/3, QUIC, and WebTransport where they fit, negotiating down cleanly so nobody one version behind gets a blank screen. |

## The punchline

toil is opinionated because being AAA on **every** axis at once forces these choices. You cannot
reach the top grade with a fast frontend on a centralized database, or a global system running
slow code, or a modern stack that only works on the newest browser. The weakest-link rule closes
every one of those escape hatches. Any framework that lets a single axis slip is, by its own
honest scoring, not AAA. Holding all nine at once is the whole reason toil looks the way it does.

## Related

- [How toil is distributed](./distributed.md): the data-path axis in depth, and why distributing
  writes is the hard one.
- [What makes toil hyper-scalable](./hyperscale.md): the topology, latency, and program axes in
  practice.
- [Security](../concepts/security.md): the security axis and its hard caps.
- [`RSG.md`](../../RSG.md) at the repository root: the full rubric, the internal mirror this page
  summarizes.

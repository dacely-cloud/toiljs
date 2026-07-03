# toil versus other stacks

An honest look at where each stack you already use hits a ceiling, and why toil bets on a different shape. Each of these tools is genuinely good at what it was built for, so the goal is not to crown a winner but to show *where* each one typically caps.

We grade with the [RSG rubric](./design-principles.md), whose rule is that a system's grade is its **weakest** axis, never the average. So the useful question is not "what is it great at?" but "what quietly caps it?" For most stacks the answer is the same axis: the **data path** (how and where writes happen), sometimes joined by **dependencies** (how much of the critical path you rent versus own).

RSG is toil's own internal rubric, not an external standard, and every stack below can be configured many ways. The caps described are the *typical* production shape, not a claim that they are unavoidable.

## Where each stack caps

| Stack | Great at | Typical binding axis | Why it caps there |
| --- | --- | --- | --- |
| **Next.js / Vercel** | DX, React, global edge reads | data path | Global reads, single-region writes: a sudden write-heavy spike concentrates on one DB box that edge caches and read replicas cannot relieve, while serverless cold starts add latency and per-invocation billing climbs exactly when load peaks |
| **Rails / Django** | Maturity, batteries included | topology / availability / data | Centralized single-region monolith: one place to be near, one place to fail, and one primary every write must reach |
| **Serverless functions** (Lambda, Cloud Functions) | Elastic stateless compute | data path | Distributes compute, not state; the central DB stays the write bottleneck, and a cold-start burst adds latency and cost right when traffic surges |
| **Edge runtimes** (Workers, Deno Deploy) | Code at the edge, near users | data path | Distributes compute beautifully, but the DB you attach is usually single-region (Durable Objects / D1 excepted, below) |
| **BaaS** (Supabase, Firebase) | Fastest to start | dependencies + data path | You rent a managed service you cannot inspect or fix, and writes resolve against a primary |
| **toil** | Owned stack, distributed writes | aims for no single binder | Every key has one home region that serializes its writes; auth, DB, email, and jobs are owned, so the usual caps are designed out (latency and client axes are still yours to earn) |

## One line each

- **Next.js / Vercel:** superb reads and DX, but a sudden spike (a viral launch, a flash sale, a timed drop where everyone writes in the same second) lands as a thundering herd on the one write region, so latency, timeouts, and per-invocation cost climb together while edge caching helps only the reads.
- **Rails / Django:** mature and productive, capped by its single-region shape; you can add replicas and standbys to climb, but distributed *writes* are not in the default model.
- **Serverless functions:** great elastic compute, but it is stateless compute in front of a central database, so a write burst still bottlenecks on that store and each cold invocation bills separately.
- **Edge runtimes:** the closest in spirit to toil's compute model, yet edge compute in front of a central database is just a faster front door to the same bottleneck.
- **Cloudflare Durable Objects / D1:** the closest mainstream analog to toil's idea, and credit is due. A Durable Object gives one object a single-writer home that serializes its writes, the same shape as ToilDB's per-key home. The difference is packaging: with the edge-runtime approach you assemble the pieces yourself (runtime, object or DB product, auth, email), whereas toil ships distributed writes, the seven database families, auth, email, streaming, and jobs as one integrated owned stack. Which you prefer is a genuine trade-off.
- **BaaS (Supabase, Firebase):** fastest to start, but the convenience is a managed service on your critical path, and writes still resolve against a primary, so it is **dependency-bound and data-bound**.

## Being honest about toil's own limits

RSG grades toil by the same weakest-link rule, and some axes are not handed to you for free:

- **Younger, smaller ecosystem.** Fewer integrations, tutorials, and hosting options than the mature stacks above. If your project is defined by a large existing integration catalog, that gap is real today.
- **The server language is a TypeScript subset.** toilscript compiles a strict subset of TypeScript to WebAssembly: no arbitrary npm packages or Node APIs on the server, built-in globals instead. That is the price of the small, fast, safe sandbox.
- **ToilDB is not SQL.** It is seven purpose-built families, not a relational engine, so heavy ad-hoc joins and existing SQL schemas are not its shape (see the [database overview](../database/README.md)).
- **Some axes you still earn.** RSG measures delivered latency, program performance, and client performance from *your* code. toil removes the structural caps, but it cannot make slow application code fast or a bloated client light.

## toil's bet

Every stack above is capped in almost the same place: the write path is one box in one region, or the critical path leans on a service you rent. toil's bet is to refuse both at once, own the whole stack and distribute the writes, so the axes that usually cap a "global" system are designed out and the only limits left are the ones your own code sets.

Whether that bet fits *your* project is the honest checklist in [Why toil](./why-toil.md).

## Related

- [Why toil? Who is it for?](./why-toil.md): the problem toil solves and the honest cases where you should not use it.
- [How toil is distributed](./distributed.md): the mechanism behind distributed writes (every key's single home region).
- [Why toil is built this way (the RSG bar)](./design-principles.md): the weakest-link rubric this comparison uses.

# toil versus other stacks

An honest, specific comparison of toil against the stacks you probably already use. The goal is not to declare a winner on every point (each of these tools is genuinely good at what it was built for) but to show *where* each one typically hits a ceiling, and why toil bets on a different shape.

Throughout, we lean on the [RSG rubric](./design-principles.md): a system's grade is its **weakest** axis, never the average. So the interesting question for any stack is not "what is it great at?" but "what quietly caps it?" For most stacks, the answer is the same axis: the **data path** (how and where writes happen), sometimes joined by **dependencies** (how much of the critical path you rent versus own).

A fair caveat before the comparisons: RSG is toil's own internal rubric, not an external standard, and every stack below can be configured in many ways. The caps described are the *typical* production shape, not a claim that a given cap is unavoidable in every configuration.

## Next.js / Vercel

**What it is genuinely great at.** Developer experience, a mature React ecosystem, excellent edge delivery of the frontend, and server rendering that is close to the user. For the read path and the UI, it is hard to beat.

**Where it typically caps.** The database. A Next.js app on Vercel usually talks to a single-region managed database (a hosted Postgres, for instance). The frontend is global; the data is not. Writes travel to that one region, so the **data path** axis is set by "latency equals distance to the primary database," regardless of how many edge locations served the page. Two secondary effects pile on: serverless functions add **cold starts** (a function that has not run recently pays a startup cost before it can even reach the database), which shows up on the latency and program axes, and the managed database plus any auth or payment vendors on the hot path sit on the **dependencies** axis, capping it below the top because those systems are ones you cannot inspect or fix.

**The honest summary.** Superb reads and DX, usually **data-path-bound**, with dependencies close behind.

## Rails / Django

**What it is genuinely great at.** Maturity, batteries-included productivity, a deep library ecosystem, and decades of hard-won conventions. If you want to build a conventional web app quickly with a full relational database and rich server-side libraries, these are still excellent and often the right call.

**Where it typically caps.** Topology. The classic Rails or Django deployment is a centralized monolith in one region, in front of one primary database. That is not a criticism of the code; it is the shape. Under RSG it caps **topology**, **availability**, and the **data path** together, because a single region is one place to be close to, one place to fail, and one place writes must go. You can add read replicas and standby regions to climb, but distributed *writes* are not part of the default model.

**The honest summary.** Mature and productive, typically **topology-bound / availability-bound / data-bound** by its single-region shape.

## Serverless functions (AWS Lambda, Cloud Functions)

**What it is genuinely great at.** Elastic, stateless compute you never have to manage a server for. Scales down to zero and up to a lot, and you pay for what you use.

**Where it typically caps.** The functions are stateless by design, which means the *state* lives somewhere else: a central database the functions call. So the same **data path** ceiling applies, the writes converge on that store, and the functions themselves add **cold starts** on the latency and program axes. Serverless is a compute model, not a data-distribution model; it moves where your code runs but not, on its own, where your data lives.

**The honest summary.** Great elastic compute, but it is compute in front of a central database, so typically **data-path-bound**.

## Edge runtimes (Cloudflare Workers, Deno Deploy)

**What it is genuinely great at.** Running your code at the edge, close to users, on modern runtimes. This is the closest in *spirit* to toil's compute model: logic next to the user rather than in one region. On the topology and modern-stack axes these runtimes are strong.

**Where it typically caps.** The data you attach. An edge runtime distributes your *compute* beautifully, but you still bring a database, and if that database is single-region, your writes are single-region and the **data path** caps the whole thing, exactly as before. Edge compute in front of a central database is a faster front door to the same bottleneck.

**A fair mention.** Cloudflare's own **Durable Objects** and **D1** are the closest mainstream analog to toil's central idea. A Durable Object gives a single-writer, single **home** for a given object (one authoritative place that serializes that object's writes), which is the same shape as ToilDB giving every key one home. It is a real answer to the write-distribution problem, and credit is due. The difference is one of packaging and reach: with the edge-runtime approach you assemble the pieces yourself (the runtime, the object or database product, auth, email, and so on), whereas toil ships a single owned stack where distributed writes, the seven database families, auth, email, streaming, and jobs are one integrated system rather than parts you wire together. Which you prefer is a real trade-off, not a slam dunk.

**The honest summary.** Excellent edge compute, typically **data-path-bound** the moment you attach a conventional database, with Durable Objects being the notable exception that attacks the same problem.

## Backend-as-a-service (Supabase, Firebase)

**What it is genuinely great at.** Batteries included, fast to start: database, auth, storage, and realtime in one product, with generous client SDKs. For getting a product off the ground quickly, they are excellent.

**Where it typically caps.** Two axes at once. First, the whole thing is a managed service on your **critical path**: a dependency you cannot inspect or patch, which caps the **dependencies** axis below the top by design. Second, the writes are region-bound. Supabase is Postgres, single-region for writes; Firestore replicates widely but still resolves writes against a primary. So the **data path** is capped too. These platforms trade ownership for speed-to-start, which is often a great trade early on, but it is a trade.

**The honest summary.** Fastest to start, typically **dependency-bound and data-path-bound**, because the convenience is a managed service you rent rather than a stack you own.

## The axes at a glance

Where each stack *typically* hits its ceiling, mapped to the RSG axis that binds it. "Cap" here means the weakest axis that sets the overall grade under the weakest-link rule, not a claim that the stack is bad.

| Stack | Data path (writes) | Dependencies | Typical binding axis | Why it caps there |
| --- | --- | --- | --- | --- |
| **Next.js / Vercel** | Single-region managed DB | Managed DB + auth/pay vendors on the hot path | data-path-bound | Global reads, but writes go to one region; vendors you cannot fix sit on the critical path |
| **Rails / Django** | Single primary DB | Few, but a single-region deploy | topology / availability / data-bound | Centralized monolith: one place to be near, one place to fail, one place writes go |
| **Serverless functions** | Central DB behind stateless functions | The managed DB (and platform) | data-path-bound | Distributes compute, not state; cold starts also weigh on latency |
| **Edge runtimes** | Whatever DB you attach (often single-region) | The attached data product | data-path-bound | Distributes compute beautifully; the attached database is the bottleneck (Durable Objects excepted) |
| **BaaS (Supabase / Firebase)** | Region-bound writes | Managed service *is* the critical path | dependency-bound + data-bound | You rent the stack (cannot inspect or fix it) and writes resolve against a primary |
| **toil** | Distributed writes: every key has one home region that serializes it | Zero third-party on the critical path (auth, DB, email, jobs are owned) | aims for no single binder (see caveats below) | Owns the whole stack and distributes writes, so the usual caps are designed out; latency and client axes still have to be *earned* by your code |

## Being honest about toil's own limits

The table above would be dishonest if it stopped there, because RSG grades toil by the same weakest-link rule, and some axes are not handed to you for free:

- **toil is younger, with a smaller ecosystem.** The stacks above have years of integrations, tutorials, hosting options, and battle-testing that toil does not have yet. If your project is defined by a large existing integration catalog, that maturity gap is real today.
- **The server language is a TypeScript subset.** toilscript compiles a strict subset of TypeScript to WebAssembly. You cannot import arbitrary npm packages or use Node APIs on the server; you use built-in globals instead. That is the price of the small, fast, safe sandbox, and it is a genuine constraint if your backend leans on the Node ecosystem.
- **ToilDB is not SQL.** It is seven purpose-built families, not a general relational engine. Heavy ad-hoc joins and existing SQL schemas are not its shape. See the [database overview](../database/README.md).
- **Some axes you still earn.** RSG measures **delivered latency**, **program performance**, and **client performance** at the user, from *your* code. toil's architecture removes the usual structural caps (topology, data path, dependencies, security), but it cannot make slow application code fast or a bloated client light. Those axes are yours to keep clean, and the framework's job is only to not be the thing holding them back.

## toil's bet

Every stack above is capped somewhere, and it is almost always the same place: the write path is one box in one region, or the critical path leans on a service you rent. toil's bet is to refuse both compromises at once: **own the whole stack** (so nothing critical is a third party you cannot fix) and **distribute the writes** (so the data path is not a single region). Do both, and the axes that usually cap a "global" system, the data path, dependencies, and security, are designed out from the start. That is what it takes to be strong on every axis *at the same time*, which is the only way to reach the top grade when your grade is your weakest link.

Whether that bet is right for *your* project depends on the honest checklist in [Why toil](./why-toil.md). The bet itself, and the rubric behind it, is what the rest of this section explains.

## Related

- [Why toil? Who is it for?](./why-toil.md): the problem toil solves and the honest cases where you should not use it.
- [How toil is distributed](./distributed.md): the mechanism behind distributed writes (every key's single home region).
- [Why toil is built this way (the RSG bar)](./design-principles.md): the weakest-link rubric this comparison is measured against.

# toil versus other stacks

An honest, axis-by-axis look at where toil trades differently from the stacks you already use. Every tool below is genuinely good at what it was built for, so the goal is not to crown a winner but to be concrete about what you gain and what you give up. toil is also younger than all of them, and that shows up in a few rows.

The short story: toil trades a large, mature ecosystem for one owned framework that distributes writes and ships the fast, safe defaults for free. Whether that trade fits your project is the honest question this page tries to answer.

## The comparison at a glance

| Axis | A typical modern stack | toil |
| --- | --- | --- |
| Pieces on the critical path | A dozen rented vendors (host, functions, database, auth, email, queue, cache, analytics, realtime), each its own account, bill, and SDK | One framework you write in; the core services are toil's own, so nothing third-party sits on the critical path |
| Where writes land | One primary region: reads go global, writes crawl back to that box | Every key has one home region that orders its writes, while data replicates outward for fast local reads (built to distribute; live multi-cell is configuration-gated) |
| Server runtime | A Node process, container, or VM per app | A small sandboxed WebAssembly module; one edge box safely runs many apps (multi-tenant), which is what makes running near everyone affordable |
| Client-to-server calls | Hand-written fetch/REST, types drift until something breaks in production | A generated, fully typed `Server` client with no raw fetch: change a field on the server and the frontend stops compiling until you fix it |
| Auth | Bolt on a provider or roll your own | Post-quantum login (ML-DSA + ML-KEM) built in, enabled in about one line |
| Getting to production | Assemble CDN, cache, regions, hardened auth, and CI yourself | Zero config: the good version is the default version |
| Toolchain | A decade of bundler configs, transpiler shims, CommonJS-versus-ESM interop, and `node_modules` churn | Built on modern web tech (React + Vite client, one CLI), far less legacy to fight |
| Database | Mature SQL: joins, ad-hoc queries, huge tooling | Seven purpose-built families (Documents, Unique, Counter, Events, Membership, Capacity, View): fast and distributed, but not relational |
| Package ecosystem | The full npm and Node universe | A strict TypeScript subset with built-in globals; no arbitrary npm packages or Node APIs on the server |
| Integration catalog | Large, mature, well documented | Smaller and younger |
| Single-region app | Dead simple, nothing to distribute | Distribution you may not need |

The top rows lean toil's way, the bottom rows lean the incumbents' way, and that split is the whole story. toil is designed to win the structural axes (one owned stack, distributed writes, a multi-tenant sandbox, end-to-end types, built-in modern auth) and it concedes the ecosystem axes (SQL, the Node universe, catalog size) that maturity buys.

## Where each stack fits

**Next.js / Vercel.** Superb React DX and global edge reads. The ceiling is the write path: pages cache worldwide, but a write (a comment, an order, a flash-sale click) still resolves against one primary region, and serverless cold starts add latency and per-invocation cost exactly when a spike hits. toil keeps a React-first client and moves the write to a home region near the data.

**Rails / Django.** Mature, productive, batteries included, an enormous ecosystem and a deep hiring pool. If you are happy in one region this is a great and boring choice. The default shape is a single-region monolith with one primary that every write must reach; you can add replicas and standbys to climb, but distributed writes are not in the model.

**Serverless functions (Lambda, Cloud Functions).** Elastic, stateless compute that scales to zero. But it is stateless compute in front of a central database, so a write burst still bottlenecks on that store, and each cold invocation bills and lags on its own.

**Edge runtimes (Workers, Deno Deploy).** The closest in spirit to toil's compute model: your code runs near users. The catch is that the database you attach is usually single-region, so edge compute becomes a faster front door to the same central write bottleneck.

Cloudflare Durable Objects and D1 are the closest mainstream analog to toil's idea, and credit is due: a Durable Object gives one object a single-writer home that orders its writes, the same shape as ToilDB's per-key home. The difference is packaging. With the edge-runtime approach you assemble the pieces yourself (runtime, object or database product, auth, email, realtime); toil ships distributed writes, the seven database families, auth, email, streaming, and background jobs as one owned stack. Which you prefer is a real trade-off.

**Backend-as-a-service (Supabase, Firebase).** The fastest thing to start with, and often the right call for a prototype. The convenience is a managed service on your critical path that you cannot inspect or patch, and writes still resolve against a primary.

## Where the incumbents still win

toil does not win every axis, and some gaps are real today. Be honest about them:

- **Mature ecosystems.** More tutorials, more answered questions, more hosting options, and more people who already know the tool.
- **SQL and joins.** If your data is relational and you live in ad-hoc queries and joins, a SQL database is the right tool. ToilDB is seven purpose-built families, not a relational engine (see the [database overview](../database/README.md)).
- **The Node package universe.** The toil server is a strict TypeScript subset compiled to WebAssembly: no arbitrary npm packages or Node APIs, built-in globals instead. That is the price of the small, fast, multi-tenant sandbox.
- **Bigger integration catalogs.** toil is younger, so the catalog of ready-made integrations is smaller. If your project is defined by a large existing integration catalog, that gap matters.
- **Single-region simplicity.** If one region already fits your users, toil's distribution is effort you do not need.

None of these are permanent, and the right tool is the one that fits the job in front of you.

## toil's bet

Most stacks cap in nearly the same place: the write path is one box in one region, or the critical path leans on services you rent and cannot fix. toil's bet is to refuse both at once, own the whole stack and distribute the writes, so the structural caps are designed out and the limits left are the ones your own code sets.

Keep the mechanism honest. The home-region model and its core logic are real and tested, but live multi-region deployment (the WAN routing and the ScyllaDB backing) is configuration-gated rather than on by default, and the local dev database is a single in-process store. Compute works the same way: your code runs at the edge on every request, while the regional, continental, and global-daemon tiers are opt-in. So the accurate claim is "toil is built to distribute writes worldwide, and the mechanism is real," not "every app is already running a live global write cluster today."

Whether that trade fits your project is the checklist in [Why toil](./why-toil.md).

## Related

- [Why toil? Who is it for?](./why-toil.md): the problem toil solves and the honest cases where you should not use it.
- [The modern stack](./modern-stack.md): the full, verified catalog of what is built in.
- [How toil is distributed](./distributed.md): the mechanism behind distributed writes (every key's single home region).
- [Why toil is built this way](./design-principles.md): the bar toil grades itself against.

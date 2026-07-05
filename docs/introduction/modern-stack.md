# The modern stack: what toil gives you that others do not

Most frameworks give you a way to write code, then send you shopping. A database, an auth provider, email, a rate limiter, analytics, a realtime service, a job runner. Each one is its own account, its own bill, and its own SDK, and you keep them all in sync.

toil owns those parts instead. They ship in the framework, they are toil's own code, and they run from the first line with no configuration. Nothing third-party sits on your critical path.

The good version is the default version. A solo builder gets the same baseline a funded team would rent from ten vendors, with nothing to assemble or babysit. This page is the full catalog. For how the edge and worldwide distribution work, see [How toil works](./how-it-works.md) and [How toil is distributed](./distributed.md).

## Built-in backend features

Your TypeScript backend declares what it needs with a decorator or a one-line config flag. toil provides the machinery.

| Feature | What it is | Why it matters |
| --- | --- | --- |
| [Post-quantum auth](../auth/README.md) | Password login via `server: { auth: true }`. The password is stretched (OPRF + Argon2id) into an ML-DSA-44 keypair in the browser; only the public key is sent; login runs ML-KEM-768 mutual auth so the client also verifies the server. | Real post-quantum cryptography (the NIST-standardized algorithms), in about one line. The password never reaches the server in a usable form, so a breached server yields nothing replayable, and there is no identity vendor to rent. |
| [ToilDB](../database/README.md) | A global database with no connection string and seven purpose-built families. Its differentiator is distributed writes: every key has one home region that orders its writes, while data replicates outward for fast local reads. | Distributes writes, not just reads, so a thousand servers can write at once with no single-region bottleneck. This is the hard part almost nobody does (trade: eventual consistency, a far read can lag a few ms). |
| [Email](../services/email.md) | `EmailService.send(...)`, or a reusable `EmailTemplate` with `{{placeholder}}` bodies, through a provider you configure once. | Verification codes, resets, and receipts are one validated, per-tenant-capped call, off the worker while the provider replies. |
| [Rate limiting](../services/ratelimit.md) | `@ratelimit` on a route, counted at the edge in an exact cross-worker limiter keyed on the caller's network address. | Over-limit clients are rejected before your code runs, blunting brute-force and spam. |
| [Analytics](../services/analytics.md) | The `Analytics` global reads your site's own counters: `self()` for a snapshot, `series(metric, range)` for a graph. | A real usage dashboard with no extra code and no analytics vendor. |
| [Realtime streaming](../realtime/README.md) | A `@stream` class with `@connect` / `@message` / `@close` / `@disconnect` hooks, opened from React with `useChannel`. WebTransport (over QUIC) in production, WebSocket in dev. | A resident instance stays alive per connection and remembers state next to the user: chat, presence, live progress. |
| [Background jobs (`@daemon`)](../background/daemons.md) | One global background worker on a schedule (interval or cron), with lease-based failover so exactly one instance runs worldwide. | Nightly jobs run once globally, with no cron server, queue, or leader election to run yourself. |
| [Scheduled jobs (`@scheduled`)](../background/daemons.md) | A method that fires on an interval or cron expression, driven by the same lease so it runs once across the fleet. | Recurring work (cleanup, digests, syncs) without standing up a scheduler. |
| [Materialized views (`@derive`)](../background/derive.md) | A function that re-runs when its source data changes and writes the result into a View family. | Rollups and denormalized read models stay fresh automatically, so reads are cheap without a hand-rolled pipeline. |
| [Sessions and cookies](../services/cookies.md) | No-import cookie read/set, signed or encrypted, plus the session layer that backs `@auth`. | Login state and small per-user data without a session store to provision. |
| [Environment and secrets](../services/environment.md) | A per-tenant environment store for config and secrets, read at the edge, never baked into the shipped WASM. | Your compiled program carries no credential; secrets live in one place, disjoint from public config. |

### The seven ToilDB families

One database, seven shapes. Each family is tuned to its own access pattern instead of forced out of a single table model.

| Family | For |
| --- | --- |
| [Documents](../database/documents.md) | General structured records. |
| [Unique](../database/unique.md) | Uniqueness constraints (one email, one handle). |
| [Counter](../database/counters.md) | High-throughput increments (views, likes, quotas). |
| [Events](../database/events.md) | Append-only logs and feeds. |
| [Membership](../database/membership.md) | Set membership and relationships (who is in what). |
| [Capacity](../database/capacity.md) | Bounded resources and seat/slot allocation. |
| [View](../database/views.md) | Read models materialized by `@derive`. |

## Built-in frontend features

The React client is Vite-fast and typed end to end. The pieces that usually take a build config, a fetch layer, and an SEO plugin are already wired.

| Feature | What it is | Why it matters |
| --- | --- | --- |
| [File routing](../frontend/routing.md) | Routes are files under `client/routes/`. The tree is your URL map. | No router config to hand-maintain; add a file, get a route. |
| [Loaders with revalidation](../frontend/data-fetching.md) | A route `loader` fetches its data before render and revalidates on demand. | Data arrives with the page, not after a client-side waterfall. |
| [Two rendering paths](../frontend/rendering.md) | Build-time prerender for SEO by default, plus opt-in edge SSR with `export const ssr = true`, both hydrated with `hydrateRoot`. | Static-fast pages where you can, live server rendering where you need it, one codebase. |
| [Typed `Server` client](../frontend/data-fetching.md) | A generated client (`Server.REST.*`, `Server.Stream.*`, `Server.<service>`) so the browser calls the backend with end-to-end types. | No hand-written fetch and no drift: rename a field on the server and the frontend stops compiling until you fix it. |
| [Image with LQIP](../frontend/images.md) | A built-in `Image` component with blur / low-quality placeholders and reserved aspect ratio. | Fast, layout-stable images with no CLS and no separate image service. |
| [Metadata and SEO](../frontend/metadata.md) | Per-route title, description, canonical, and Open Graph (including `og:image`), baked into the served HTML head. | Correct SEO and share cards in view-source, not assembled by JavaScript after load. |
| [Page search](../frontend/search.md) | A static index of each route's title, description, keywords, and Open Graph, generated at build. | In-app search with no search vendor (see the caveat below). |
| [SHA-384 SRI](../concepts/security.md) | Subresource Integrity plus importmap integrity on every shipped script, preload, and stylesheet, across the whole module graph. | A tampered asset simply does not run, even if a CDN or cache hop is compromised. |

## toil versus a typical stack

Everything above is toil's own code on your critical path. You can inspect it, patch it, and secure it. The table below draws the difference.

| Capability | toil (built in, zero setup) | Typical stack (you assemble it) |
| --- | --- | --- |
| Database | ToilDB: global, distributed writes, seven families | A managed database, usually single-region for writes |
| Auth | Post-quantum login; the server holds no password | A rented identity provider or hand-rolled hashing |
| Email, rate limiting, analytics | Built-in primitives, one call each | A separate SDK or vendor per capability |
| Realtime and background | `@stream`, `@daemon`, `@scheduled`, `@derive` | A realtime service plus a cron server, queue, and leader election |
| Sessions, secrets, cookies | Owned globals, no store to provision | A session store and a secrets manager to run |
| Frontend integrity and SEO | Automatic SHA-384 SRI, Image/LQIP, metadata, page search | Plugins and services bolted on per concern |
| Critical-path ownership | The core is toil's own | A mix of vendors you cannot inspect or fix |

Owned means the core of a working app is toil's. It does not mean outside services are banned. You can still call a payment provider or any other API.

## Honest limits

toil grades itself on honesty. Read these before you count on anything.

- **Distributed writes are built, live multi-cell is config-gated.** The home-region model and its core logic are real and tested. Live multi-region deployment (WAN routing, the ScyllaDB backing) is opt-in, not on by default. The local dev database is a single in-process store. toil is built to distribute writes worldwide. Not every app is running a live global write cluster today.
- **Analytics is a dev stub locally.** It is real on the edge. The local dev server returns sample data.
- **Auth secrets ship as dev placeholders.** The session HMAC, OPRF seed, and ML-KEM key are clearly insecure placeholders so `toiljs dev` just works. A real deployment must set its own. Per-tenant auto-generation at domain registration is the plan.
- **Page search indexes static metadata only.** Routes whose metadata comes from a dynamic `generateMetadata` are not in the index.

## Why these ship by default

None of this is an upgrade you unlock later. toil grades itself against [RSG](./design-principles.md), the Resilience and Scale Grade. Its one rule: your grade is your weakest axis, never the average. These built-in parts exist so no single axis quietly caps the whole.

The trades are real. ToilDB is not general SQL. The server language is a strict TypeScript subset. The catalog is younger than long-established platforms. Where those trades fit your project, the built-in stack earns its place. [Why toil](./why-toil.md) covers where it does not.

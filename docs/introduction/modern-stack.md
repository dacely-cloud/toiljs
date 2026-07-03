# The modern stack: what toil gives you that others do not

Most frameworks give you a way to write code and then send you shopping: a database, an auth provider, email, a rate limiter, analytics, a realtime service, a job runner, all wired together and kept in sync by you. toil owns those parts instead: built in, and on from the first line. This page is the catalog of what ships; for how the edge and distribution actually work, see [How toil works](./how-it-works.md) and [How toil is distributed](./distributed.md).

## What is built in

| Feature | What it is | Why it matters |
| --- | --- | --- |
| Edge compute over HTTP/3 | Frontend and backend both run on servers in many cities, over HTTP/3 with automatic fallback to HTTP/2 or HTTP/1.1. | Code runs next to the user, so there is no slow round trip to one origin. |
| [ToilDB](../database/README.md) | A global database with no connection string and seven families (documents, unique, counter, events, capacity, membership, view). | Distributes writes, not just reads, so a thousand servers can write at once without a single-region bottleneck (trade: eventual consistency). |
| [Post-quantum auth](../auth/README.md) | Password login via `server: { auth: true }`; the password becomes an ML-DSA-44 key in the browser and the server stores only the public key. | The password never crosses the wire in a replayable form, so a breached server yields no usable passwords, and there is no identity vendor to rent. |
| Automatic SRI | A SHA-384 fingerprint on every local script, preload, and stylesheet, plus an import map covering the whole module graph. | Tampered assets simply do not run, even if a CDN or cache hop is compromised. |
| [Email](../services/email.md) | `EmailService.send(...)` or a reusable `EmailTemplate` with `{{placeholder}}` bodies, through a provider you configure once. | Verification codes, resets, and receipts are one call: validated, per-tenant capped, and off the worker while the provider replies. |
| [Rate limiting](../services/ratelimit.md) | `@ratelimit` on a route, counted at the edge in an exact cross-worker limiter keyed on the caller's network address. | Over-limit clients are rejected before your code runs, blunting brute-force and spam. |
| [Analytics and time series](../services/analytics.md) | The `Analytics` global reads your site's own counters: `self()` for a snapshot, `series(metric, range)` for a graph. | A real usage dashboard with no extra code and no analytics vendor, correct across every edge location. |
| [Realtime streaming](../realtime/README.md) | A `@stream` class with `@connect`/`@message`/`@close`/`@disconnect` hooks, opened from React with `useChannel`; WebTransport in production, WebSocket in dev. | A resident instance stays alive per connection and remembers state next to the user (chat, presence, progress). |
| [Daemons and @derive](../background/README.md) | `@daemon` runs one global background worker on a schedule (interval or cron) with lease-based failover; `@derive` re-runs when its source data changes to refresh a View. | Nightly jobs and rollups run once globally, with no cron server, queue, or leader election to run yourself. |
| [Owned globals](../services/README.md) | No-import cookies (read/set, sign or encrypt), crypto (hash, HMAC, AES, random), time (the edge clock), and environment/secrets. | Your request's small dependencies live in one system, and your compiled program carries no credential. |
| [Toolchain](../cli/README.md) | `toiljs create` scaffolding, a shared ESLint config, Prettier plus a decorator-aware plugin, an editor plugin, one CLI, and `toiljs doctor --fix`. | Set up for you and wired by types, so a server change is a compile error at your desk, not a production bug. |
| LLM-friendly docs | A machine-readable `llms.txt` plus a generated `.toil/docs/` folder and pointer files (`CLAUDE.md`, `AGENTS.md`, editor rules), refreshed on every build. | An assistant reads your current conventions instead of guessing from stale training. |

## Built in versus assemble it yourself

| Capability | toil (built in, zero setup) | Typical stack (you assemble it) |
| --- | --- | --- |
| Edge and transport | Frontend and backend worldwide over HTTP/3 | A separate edge product, often reads-only |
| Database | ToilDB: global, distributed writes, seven families | A managed database, usually single-region for writes |
| Auth | Post-quantum login; the server holds no password | A rented identity provider or hand-rolled hashing |
| Email, rate limiting, analytics | Built-in primitives, one call each | A separate SDK or vendor per capability |
| Realtime and background | `@stream`, `@daemon`, `@derive` | A realtime service plus a cron server, queue, and leader election |
| Asset integrity and toolchain | Automatic SRI, ESLint/Prettier/editor plugins, one CLI | Manual or skipped; configured and maintained by you |
| Critical-path ownership | The core is toil's own | A mix of vendors you cannot inspect or fix |

## Why it is all a default

None of this is an upgrade you unlock later. toil grades itself against [RSG](./design-principles.md) (Resilience and Scale Grade), whose one rule is that your grade is your weakest axis, never the average, so these batteries exist to keep any single axis from quietly capping the whole. Where the honest trade fits your project (ToilDB is not general SQL, the server language is a strict TypeScript subset, the catalog is younger than long-established platforms), the built-in stack is the whole point; [Why toil](./why-toil.md) says where it does not.

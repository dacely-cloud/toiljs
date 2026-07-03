# The modern stack: what toil gives you that others do not

Most frameworks give you a way to write code and then send you shopping: pick a database, an auth provider, an email service, a rate limiter, analytics, a realtime service, a job runner, then wire it all together and keep it in sync.

toil takes the opposite bet. The modern parts of a real app are built in, owned by the framework, and on from the first line. This page is the catalog: for each piece, what it is, why it matters, and that it is already there with zero setup. Everything is confirmed in the codebase; anything planned rather than shipped is marked.

## Edge compute over HTTP/3

Your frontend and backend both run on the **edge**: servers in many cities, each near some of your users. The connection uses **HTTP/3 over QUIC**, the newest web transport (low latency, and it survives a phone switching from Wi-Fi to cellular). Older clients drop to HTTP/2 or HTTP/1.1 automatically, so no one gets a blank screen.

Running code next to the user removes the slow trip to one origin. You never configure the transport: deploy, and the edge serves your pages and runs your backend. See [How toil works](./how-it-works.md).

## ToilDB: a global distributed database

Built in, **global**, no connection string, no region to pick. Instead of one general-purpose table it gives you **seven families**, each tuned for one job:

| Family | It stores |
| --- | --- |
| Documents | Records looked up by id (users, posts) |
| Unique | A one-of-a-kind claim (usernames, emails) |
| Counter | A total many callers bump at once (likes) |
| Events | An append-only log (feeds, audit trails) |
| Capacity | A limited quantity you must not oversell (tickets) |
| Membership | Sets of who belongs to what (followers, tags) |
| View | A precomputed read snapshot (leaderboards) |

The headline is **distributed writes**. Every key has one **home** region that orders its writes, so a thousand servers writing at once cannot lose data; reads come from a nearby copy, fast everywhere. Distributing writes, not just reads, is the part almost nobody does.

Trade: eventual consistency (a far-region read can lag a few milliseconds after a write). See [the database overview](../database/README.md).

## Post-quantum auth, in one line

A complete password login you turn on with `server: { auth: true }`. "Post-quantum" means the cryptography stays safe even against a future quantum computer. The password is stretched in the browser (with Argon2id, a slow, memory-hard hash) into an ML-DSA-44 signing key; your server stores only the *public* key and verifies a signed challenge.

Why it matters: the usual "send the password, hash it on the server" pattern leaves a live, replayable credential in server memory for a moment. toil never lets the password cross the wire in a replayable form, so a fully breached server yields no usable passwords, and there is no identity vendor to rent.

You get `/auth/*`, sessions, `@auth`-guarded routes, and a browser client for free. See [auth](../auth/README.md). (A deploy must set the auth secrets first.)

## Automatic Subresource Integrity

**SRI** is a browser check: attach a fingerprint to each script and stylesheet, and the browser refuses any file whose bytes do not match. At build time toil adds a SHA-384 fingerprint to every local script, preload, and stylesheet, plus an import map so the *whole* module graph is covered, not just the entry file.

Your JS and CSS travel through networks and caches. If any hop is compromised, tampered code could steal sessions or skim forms. SRI makes tampered code simply not run.

It is automatic in production, and content-hashing keeps a fingerprint from ever falsely mismatching on a deploy. Verified in [`../../src/compiler/sri.ts`](../../src/compiler/sri.ts); depth in [Security](../concepts/security.md).

## Built-in transactional email

Send a one-off with `EmailService.send(...)`, or define a reusable `EmailTemplate` with `{{placeholder}}` interpolation and text/HTML bodies. Delivery goes through a provider you configure once.

Verification codes, resets, and receipts are usually another SDK and account on your request path; here they are one call. The send suspends off-core until the provider replies (no blocked worker), is validated (one recipient, no header injection), and is capped per tenant. Local dev sends for real too. See [email](../services/email.md).

## Built-in rate limiting

Add `@ratelimit` to a route to cap how often a client may hit it. Counting happens at the edge, in an exact limiter shared across workers, keyed by default on the caller's unspoofable network address (never a forgeable header).

Login, signup, and public writes are abusable. Rejecting an over-limit client **before your code runs** blunts brute-force and spam and absorbs bursts at the edge. Only opted-in routes pay anything, and there is no separate limiter to provision. See [rate limiting](../services/ratelimit.md).

## Built-in analytics and time series

`Analytics` is an ambient global (no import) that reads your site's own counters: requests, bytes, status codes, cache hits, database ops and latency, stream and daemon activity, emails, memory. `Analytics.self()` is a snapshot; `Analytics.series(metric, range)` returns per-bucket totals for a graph.

You can build a real usage dashboard with no extra code and no analytics vendor, and the totals are correct across every edge location. It is per-domain infrastructure metering, not per-user product analytics. Dev returns sample data so you can build locally. See [analytics](../services/analytics.md).

## Realtime streaming

Push to the browser the instant something happens, over one long-lived connection. Write a server class marked `@stream` with four hooks (`@connect`, `@message`, `@close`, `@disconnect`); from React, open it with the `useChannel` hook or the generated `Server.Stream.<Class>.connect()`. Production uses **WebTransport** (built on HTTP/3); dev uses a WebSocket, with identical code.

Chat, presence, live cursors, and progress bars fit poorly in the ask-again model. A stream keeps a resident instance alive for the connection, so it remembers state between messages, served next to the user. See [realtime](../realtime/README.md). (A broadcast `@channel` feature is planned; the streams here are shipped.)

## Background daemons and scheduled jobs

Two tools for work with no user waiting:

- **`@daemon`**: one global background worker on a schedule (an interval, or a cron time like "9:15 on weekdays"), exactly one worldwide, held by a lease with automatic failover to a warm standby.
- **`@derive`**: not on a timer; it re-runs whenever its source data changes, to keep a precomputed View fresh.

Nightly cleanups, periodic polls, and rollups must run **once globally**, not per server and not twice; a `@daemon` is that home. A `@derive` keeps an expensive read (a leaderboard, a latest-N feed) as a single cheap lookup. No cron server, queue, or leader election to run yourself. See [background work](../background/README.md).

## Everyday globals, owned

The small tools come the same way, as no-import globals:

- **cookies**: read, set, and optionally sign or encrypt values.
- **crypto**: hashing, HMAC, AES, random bytes.
- **time**: the edge clock through one blessed API.
- **environment/secrets**: config and secrets set outside your code, so your compiled program carries no credential.

These round out the owned stack: the parts your request depends on live in one system toil can fix, not a pile of rented black boxes. It does not ban outside services (call a payment API through the secrets store and outbound HTTP); it means a working app's *core* is not black boxes. See [platform services](../services/README.md).

## The toolchain: it just works

Set up for you, not left as homework:

- **`toiljs create`** scaffolds a working app and wires every preset.
- **ESLint** as a shared config (`toiljs/eslint`), on from the first commit.
- **Prettier** with a config and a **plugin** that formats toil's server decorators (plain Prettier rejects them).
- An **editor plugin** that teaches VS Code / WebStorm about toil-injected members, so valid code stops getting flagged.
- **One CLI** for `create`, `dev`, `build`, and self-hosting.
- **`toiljs doctor`**, plus **`--fix`** to repair many issues in place (typed-client wiring, the Prettier and editor plugins, stale declarations); `--json` for CI.

TypeScript is end to end and wired by types, so a server change becomes a compile error at your desk, not a production bug. See the [CLI reference](../cli/README.md).

## LLM-friendly docs

The docs are built for AI assistants too. The framework ships a machine-readable index (`llms.txt`), and every project gets a generated `.toil/docs/` folder (refreshed on each `dev` and `build`, so it matches your installed version) plus pointer files: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.github/copilot-instructions.md`.

An assistant that reads your *current* conventions writes code that fits toil instead of guessing from stale training. Verified in [`../../src/compiler/docs.ts`](../../src/compiler/docs.ts).

## Why it is all a default: the AAA bar

None of this is an upgrade you unlock later. toil grades itself against **RSG** (Resilience and Scale Grade), scored AAA down to D, whose one rule is that **your grade is your weakest axis**, never the average. The top grade needs topology, availability, the write path, latency, efficiency, dependencies, security, client reach, and modern-stack compatibility to all hold at once. These batteries are how toil keeps any single axis from quietly capping it. See [design principles](./design-principles.md).

## toil (built in) versus a typical stack (you assemble it)

| Capability | toil (built in, zero setup) | Typical stack (you assemble it) |
| --- | --- | --- |
| Edge compute | Frontend and backend run worldwide by default | A separate edge/host product, often reads-only |
| Transport | HTTP/3 over QUIC, graceful fallback | Depends on the host |
| Database | ToilDB, global, distributed writes, 7 families | A managed database, usually single-region for writes |
| Auth | Post-quantum login, one line, server holds no password | A rented identity provider or hand-rolled hashing |
| Asset integrity | Automatic SRI over the whole module graph | Manual, or skipped |
| Email | Built-in primitive plus templates | A separate email SDK and account |
| Rate limiting | `@ratelimit`, enforced at the edge | A separate limiter or shared cache |
| Analytics | Per-domain counters and time series from a route | A third-party analytics tool |
| Realtime | `@stream` plus `useChannel`, over WebTransport | A separate realtime service |
| Background jobs | `@daemon` (global singleton) and `@derive` | A cron server plus a queue plus leader election |
| Toolchain | ESLint, Prettier plus plugin, editor plugin, one CLI, doctor | Configured and maintained by you |
| AI docs | `llms.txt` plus generated `.toil/docs` and pointer files | Not provided |
| Critical-path ownership | The core is toil's own | A mix of vendors you cannot inspect or fix |

The trade is the honest one from [Why toil](./why-toil.md): ToilDB is not general SQL, the server language is a strict TypeScript subset, and the integration catalog is younger than long-established platforms. Where those fit your project, the built-in stack is the whole point; where they do not, that page says so plainly.

## Related

- [Why toil? Who is it for?](./why-toil.md): the thesis, who benefits, and the honest cases against.
- [Why toil is built this way (the RSG bar)](./design-principles.md): the weakest-link rubric these defaults aim at.
- [Security](../concepts/security.md): the sandbox, post-quantum login, secrets, and Subresource Integrity in depth.
- [Realtime](../realtime/README.md): the streaming pillar, the `@stream` class, and the client hook.

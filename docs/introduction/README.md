# Understanding toil

toil is one framework for a whole web app: the frontend, the backend, and the database, in a single project, all running close to your users.

You write React for the client and TypeScript for the server. toil compiles the server to WebAssembly and runs it at the edge, next to whoever is asking. Auth, database, email, realtime, and background jobs are already built in. Nothing to wire up, nothing to configure. A pizza site gets the same infrastructure a funded team would rent from ten separate vendors.

This section explains what that means and why it holds up. Start here, then follow the links at the end.

## What toil is

A toil project has three parts in one folder:

- `client/` is your React app: file-based routing, data loaders, and a typed client for calling the server.
- `server/` is your backend, plain TypeScript marked up with decorators like `@rest`, `@data`, and `@auth`. toil compiles it to a small sandboxed WebAssembly module.
- ToilDB is your database. It is already there. No connection string, no instance to spin up.

Types tie the three together. Change a field on the server and the client stops compiling until you fix it. Edge deployment, post-quantum login, and asset tamper-proofing are on by default, not features you bolt on later.

## The problem it solves

A good web app should be fast everywhere, secure by default, and able to grow without a rewrite. Getting there is the hard part, and most of it has nothing to do with your actual product.

You assemble it from rented parts: a host, serverless functions, a database, an auth provider, email, a cache, a queue, analytics, a realtime service. Each is its own account, bill, and SDK, and you keep them all in sync. Under that sits a decade of legacy tooling and a node_modules folder heavier than your app. Worse, the fast and secure version is never the default. A CDN, careful caching, region tuning, hardened auth, current crypto: all of it is extra work, so most apps ship slower and less safe than they should.

toil deletes that assembly. One framework runs your frontend, backend, and database at the edge, next to users. Auth, email, realtime, and background jobs are built in and owned. Login is post-quantum out of the box. There is nothing to wire up and no infrastructure to reason about. The good version is the only version.

Distributing writes worldwide is one of the hard problems it handles under the hood. Most stacks spread reads everywhere but pin every write to one region, so a user far from it waits for a round trip and that region is a single point of failure. ToilDB is built to distribute the writes too: every key has a home region that orders its writes while the data copies outward for fast local reads. You never set any of it up.

```mermaid
flowchart TB
    subgraph Assemble["The usual way: rent and wire the parts yourself"]
        direction TB
        A["Your app"] --> H["host"]
        A --> F["functions"]
        A --> D["database"]
        A --> Au["auth"]
        A --> Em["email"]
        A --> Rt["realtime"]
        A --> J["jobs"]
    end
    subgraph Toil["toil: one framework, at the edge, by default"]
        direction TB
        A2["Your app"] --> T["frontend + backend + database + auth +<br/>email + realtime + jobs, built in and near users"]
    end
```

## Where to go from here

Read these in order. Each one builds on the last.

1. **[Why toil, and who it is for](./why-toil.md)** What is wrong with a modern stack, who gains most from toil, and the honest cases against it.
2. **[What comes built in](./modern-stack.md)** The full list of what toil owns and runs for you, and what it does not.
3. **[How toil works](./how-it-works.md)** The whole path, from a React click through WebAssembly to ToilDB and back.
4. **[Why it scales cheaply](./hyperscale.md)** How one small program can serve the whole planet without a per-app server bill.
5. **[How toil distributes writes](./distributed.md)** One of the hardest problems in web infrastructure, and how ToilDB is built to solve it.
6. **[toil next to other stacks](./vs-other-frameworks.md)** A fair comparison with Next.js, Rails, serverless, and the rest, wins and losses both.
7. **[The bar toil holds itself to](./design-principles.md)** The RSG rubric, and its one rule: your grade is your weakest part.

## The short answer

- **Who it is for:** anyone shipping a real product who wants global speed without a platform team or ten stitched-together services.
- **Why it is fast:** the code runs next to the user, with no trip to a distant origin.
- **Why it is different:** the whole stack is built in and owned, so there is nothing to assemble, and it distributes writes worldwide, not only reads.
- **Why it is safe:** the backend is sandboxed, passwords never reach the server in a usable form, secrets never ship in the code, and the browser checks every file it loads.

Ready to build? Jump to [Getting started](../getting-started/README.md).

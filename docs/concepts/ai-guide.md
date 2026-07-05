# Writing toiljs correctly

This is a fast, high-signal cheat-sheet for writing toiljs and toilscript code that compiles and behaves. It is aimed at AI assistants generating code (and at humans in a hurry): the patterns to follow, the mistakes to avoid, and a link to the deep page whenever you need more. It does not re-teach the framework; each section points you at the authoritative doc.

## Project shape

A toiljs project has three top-level folders, and knowing which one a file belongs to tells you which rules apply:

- **`client/`**: your React app that runs in the browser. Pages live under `client/routes/`, one file per URL, and each route file `export default`s its component. See [Frontend](../frontend/README.md) and [Routing](../frontend/routing.md).
- **`shared/`**: a generated typed bridge (`shared/server.ts`) that lets the browser call the backend with full types. It is regenerated on every build, so **never hand-edit it**.
- **`server/`**: your backend, written in TypeScript but compiled by **toilscript** to WebAssembly. It runs on the Dacely edge, not in Node or the browser. See [Backend](../backend/README.md).

Most code runs on the L1 request tier. Long-lived connections (`@stream`) and scheduled work (`@daemon`) are opt-in tiers in their own entry files. See [Compute tiers](./tiers.md).

## Client rules (the browser, React side)

**Call the backend only through the generated `Server` client.** This is the number one rule. Use `Server.REST.<controller>.<route>(args)` for `@rest` HTTP controllers, or `Server.<service>.<method>(args)` / `Server.<remote>(args)` for RPC. Raw `fetch` to your own backend throws away the type safety, the argument and result decoding, and the binary wire codec, and it silently breaks when a route is renamed. `fetch` is only for third-party URLs (an external API, a CDN). See [Fetching data](../frontend/data-fetching.md).

```ts
// WRONG: raw fetch to your own backend
await fetch('/account/session', { method: 'POST' });

// RIGHT: the typed client (renames become compile errors; args + result typed)
await Server.REST.account.session();
```

**Use the ambient `Toil.*` globals with no import.** `Toil` is the `toiljs/client` package exposed as a global and typed via a generated `toil-env.d.ts`, so it autocompletes with no import: `Toil.Link` / `Toil.NavLink` for navigation, `Toil.useParams`, `Toil.useLoaderData`, `Toil.Image`, `Toil.useHead` / `Toil.Head`, `Toil.Form` / `Toil.useAction`, and more. `Server` and `parseError` are also bare globals; `FastMap`, `FastSet`, `DataWriter`, and `DataReader` are bare globals too (write `new DataWriter()`, not `new Toil.DataWriter()`). Full index: [The Toil global](../frontend/toil-global.md).

**Load page data with a `loader`, not a `useEffect` fetch.** A route file exports a `loader`, and the component reads its result with `Toil.useLoaderData`. The loader runs on navigation in parallel with the route chunk, integrates with `loading.tsx`, caching, and SSR hydration. A `useEffect` fetch runs only after mount (slower, invisible to the server).

```tsx
// client/routes/blog/[id].tsx
export const loader = async ({ params }: Toil.LoaderArgs) => {
  return Server.REST.blog.get({ params: { id: params.id } });
};

export default function BlogPost() {
  const post = Toil.useLoaderData<typeof loader>();
  return <article><h1>{post.title}</h1></article>;
}
```

**Mutate with `Toil.useAction` or `<Toil.Form>`, then revalidate.** Both track pending and error state and refetch the affected loader data on success, so the page updates without a manual refetch. Use `<Toil.Form>` for form submits, `useAction` for anything else (a delete button, a toggle). Reach for `Toil.revalidate()` / `router.revalidate()` after a write that these do not cover.

**Per-route SEO with `export const metadata`** (or `Toil.useHead` / `<Toil.Head>` from inside a component). Opt a route into edge SSR with `export const ssr = true`. See [Metadata and SEO](../frontend/metadata.md) and [Rendering and SSR](../frontend/rendering.md).

**Typed hrefs.** `Toil.Link` `href`, `Toil.navigate`, and `router.push` are all type-checked against your real routes, so a typo is a compile error. Use `Toil.href(str)` only when a URL is assembled from data and TypeScript cannot prove it is a real route. See [Navigation](../frontend/navigation.md).

**`getUser()` on the client is display-only.** It reads a readable session cookie with no network call, so it is instant but **forgeable**. Use it to render "logged in as ...", never to gate real access. The authoritative check is a server route guarded with `@auth`. See [Auth usage](../auth/usage.md).

## Server rules (toilscript, compiles to WASM)

The decorators, each doing one job (full list in [Decorators](./decorators.md)):

- **`@data`** on a class: generates the binary and JSON codec so the value can cross the wire and the database. Every field needs a default; field order **is** the binary layout, so add new fields at the end. See [Data types](../backend/data.md).
- **`@rest('name')`** on a class mounts an HTTP controller at `/name`; **`@get`/`@post`/`@put`/`@del`/`@patch`** on its methods declare routes (`@del`, not `@delete`, which is reserved). See [REST](../backend/rest.md).
- **`@service`** + **`@remote`** expose typed RPC callable from your own frontend as `Server.<service>.<method>()`. See [RPC](../backend/rpc.md).
- **`@user`** declares the authenticated-user shape and enables `AuthService.getUser()`. **Exactly one `@user` per project.** **`@auth`** guards a route or a whole `@rest` class. See [Auth](../auth/README.md).
- **`@ratelimit(strategy, limit, window)`** caps how often a caller may hit a route, rejected at the edge before your code runs. See [Security](./security.md).
- **`@database`** + **`@collection`** declare a ToilDB schema (below).

```ts
@rest('players')
class Players {
  @get('/:id')
  public get(ctx: RouteContext): Response {
    const id = ctx.param('id');
    return Response.json(`{"id":"${id}"}`);
  }
}
```

**`@auth` rejects with 401 before your handler runs.** So inside an `@auth`-guarded handler, `AuthService.getUser()!` is guaranteed non-null and safe to assert. Without `@auth`, `getUser()` can be null, so null-check it instead. Either way the server re-verifies the signed session, so it (not the client cookie) is the real authorization boundary.

```ts
@auth
@get('/settings')
public settings(): Response {
  const user = AuthService.getUser()!;   // safe: @auth guarantees a session
  return Response.text('hi ' + user.username);
}
```

**Server code is a strict, WASM-targeted dialect (AssemblyScript), not full TypeScript.** The real constraints, verified against the toilscript standard library:

- **Use explicit value types**, never `number`: `i32` / `u32` / `i64` / `u64` / `f64` (and `i8`/`u8`/`i16`/`u16`/`f32`, plus `u128`..`u256`), `bool`, `string`, `Uint8Array`. Plain `number` resolves to `f64`, which is wrong for ids and counts. Integer math **wraps** on overflow (it never throws), and integer `/` truncates. See [The type system](./types.md).
- **No `any`.** Every value has a concrete type; that is what lets it compile to WASM.
- **No arbitrary npm.** Only the toilscript standard library plus the toiljs host APIs.
- **Use `null`, not `undefined`** for "no value" (`T | null`, narrowed with `if (x != null)` or a `!` assertion).
- **No usable built-in `RegExp`** (it is a host stub that throws). Parse strings by hand.
- **Structured values are `@data` classes, not object literals.** Encode and decode raw binary with `DataWriter` / `DataReader` (imported on the server from the `data` module: `import { DataWriter, DataReader } from 'data';`). For dynamic JSON, use the ambient `JSON` value tree.
- **Read config with `Environment.get(key)` and secrets with `Environment.getSecure(key)`** (each returns `string | null`; the two buckets are disjoint so a secret can never leak through `get`). See [Environment](../services/environment.md).
- **Return a runtime `Response`** (`Response.json` / `.text` / `.html` / `.bytes` / `.notFound` / ...), or return a `@data` value and let toiljs serialize it.

**ToilDB has seven collection families; pick the one that matches the job** (do not force everything into one). Declare each as a `static` `@collection` field on a `@database` class, typed by its family, and reach it statically (`AppDb.users.get(...)`). See [The database](../database/README.md) and [Setup](../database/setup.md).

- **`Documents<K,V>`**: the default record store, looked up by id (users, posts, orders).
- **`Unique<K,V>`**: a globally one-of-a-kind claim (usernames, emails, slugs).
- **`Counter<K>`**: a running total many callers bump at once (likes, views); `add` a delta only.
- **`Events<K,V>`**: an append-only log kept in order (feeds, audit trails).
- **`Capacity<K>`**: a limited quantity handed out without overselling (tickets, seats).
- **`Membership<K,M>`**: sets of who belongs to what (followers, tags, room members).
- **`View<K,V>`**: a precomputed read-optimized snapshot (leaderboards, home pages).

**Data access is gated by function kind.** A `@get` route is a read-only **Query**; a `@post` route is an **Action** (may write); a plain `@remote` defaults to read-only Query, so add **`@action`** to let it write. Scans (`events.latest`, `membership.list`) are barred from request handlers: do them in a `@derive` and have the request read the resulting `View`. The compiler enforces this and the edge re-checks it.

## Common mistakes

A short do-not list. Every one of these is a real, avoidable error:

- **Raw `fetch` to your own backend.** Go through `Server.*` instead.
- **Importing `Toil.*`.** They are ambient globals; importing them is wrong.
- **Fetching page data in a `useEffect`.** Use a route `loader` + `Toil.useLoaderData`.
- **A plain `<a>` for in-app links.** Use `Toil.Link` (a bare `<a>` triggers a full reload).
- **More than one `@user`.** Exactly one per project.
- **Trusting client `getUser()` for authorization.** It is display-only and forgeable; enforce on the server with `@auth`.
- **`any`, `number`, or `RegExp` in server code.** Use explicit value types; there is no usable `RegExp`.
- **Reordering `@data` fields** (or changing a field type) on a stored type. Field order is the layout; add at the end and use `@migrate` to evolve. See [Data types](../backend/data.md).
- **Writing from a plain `@remote` or `@get`.** Reads are the default; a write needs `@action`.
- **Calling a scan (`events.latest`, `membership.list`) from a request handler.** Do it in a `@derive`.
- **Hand-editing `shared/server.ts` or `.toil/`.** They are generated; rebuild instead.

## Where to go deeper

- Concepts: [Decorators](./decorators.md), [Type system](./types.md), [Security](./security.md), [Compute tiers](./tiers.md).
- Backend: [Overview](../backend/README.md), [REST](../backend/rest.md), [RPC](../backend/rpc.md), [Data types](../backend/data.md).
- Frontend: [Overview](../frontend/README.md), [Fetching data](../frontend/data-fetching.md), [Routing](../frontend/routing.md), [Navigation](../frontend/navigation.md), [The Toil global](../frontend/toil-global.md).
- Database: [ToilDB overview](../database/README.md), [Setup](../database/setup.md).
- Auth: [Overview](../auth/README.md), [Usage](../auth/usage.md).
- Services: [Environment](../services/environment.md), [Rate limiting](../services/ratelimit.md).
</content>
</invoke>

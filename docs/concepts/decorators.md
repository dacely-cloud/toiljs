# Decorators reference

Every feature of a toiljs backend, an HTTP route, an RPC method, a database collection, a scheduled job, is switched on by a **decorator**. This page lists them all, grouped by what they do, so you can find the right one at a glance and jump to the page that covers it in depth.

## What a decorator is

A **decorator** is the `@name` you write on the line just above a class, a method, or a field. It attaches meaning to that code without changing what the code itself does. You are labelling it so the compiler knows how to wire it up.

```ts
@rest('users')          // <- a class decorator: "this class is an HTTP controller"
class Users {
    @get('/:id')        // <- a method decorator: "this method answers GET /users/:id"
    public byId(): Response { /* ... */ }
}
```

Three things to notice, because they decide where each decorator can go:

- Some decorators apply to a **class** (`@rest`, `@service`, `@stream`, `@daemon`, `@database`, `@data`, `@user`).
- Some apply to a **method** or a free **function** (`@get`, `@remote`, `@scheduled`, `@query`).
- One applies to a **field** (`@collection`).

Some take arguments, like `@get('/:id')` or `@cache(60)`; the bare ones, like `@rest` or `@daemon`, do not. You never register anything by hand: tagging the code is enough, and the build discovers it.

Each decorator also belongs to a **tier** (where its code runs) or is **shared** (compiled into every tier). If tiers are new to you, read [Compute tiers](./tiers.md) first; the short version is L1 = per-request at the edge, L2 / L3 = long-lived stream connections, L4 = one global daemon.

## Routing and HTTP (L1)

Turn a class into an HTTP controller and its methods into routes. All run on the L1 request tier. Covered in [REST](../backend/rest.md).

| Decorator | Applies to | What it does |
| --- | --- | --- |
| `@rest` | class | Marks the class an HTTP controller, mounted at a prefix (`@rest('users')` -> `/users`). |
| `@route` | method | Declares a route with an explicit method + path: `@route({ method: Methods.GET, path: '/' })`. |
| `@get` | method | Shorthand for a `GET` route: `@get('/:id')`. |
| `@post` | method | Shorthand for a `POST` route. |
| `@put` | method | Shorthand for a `PUT` route. |
| `@del` | method | Shorthand for a `DELETE` route (named `del` because `delete` is a reserved word). |
| `@patch` | method | Shorthand for a `PATCH` route. |
| `@head` | method | Shorthand for a `HEAD` route. |
| `@options` | method | Shorthand for an `OPTIONS` route. |

## RPC (L1)

Expose server functions that your own frontend calls like typed async functions. Run on L1. Covered in [RPC](../backend/rpc.md).

| Decorator | Applies to | What it does |
| --- | --- | --- |
| `@service` | class | Marks an RPC service; its `@remote` methods are namespaced under the generated client as `Server.<service>.<method>()`. |
| `@remote` | method / function | Marks a method (of a `@service`) or a top-level function as a client-callable RPC endpoint. |

## Guards and policy (L1)

Attach a rule to a route (or a whole controller). These stack above a route method. Run on L1.

| Decorator | Applies to | What it does | Covered in |
| --- | --- | --- | --- |
| `@auth` | class / method | Requires a valid session; returns `401` otherwise. On a class it guards every route. | [Auth usage](../auth/usage.md) |
| `@cache` | method | Caches the response at the edge and browser: `@cache(edgeMinutes, browserSeconds?, privateScope?, allowAuth?)`. | [Caching](../services/caching.md) |
| `@ratelimit` | method | Rate-limits a route: `@ratelimit(strategy, limit, window)`. | [Rate limiting](../services/ratelimit.md) |

## Realtime streams (L2 / L3)

Handle a long-lived connection, keeping state per connected client. The `@stream` class runs on the L2 / L3 stream tier; its lifecycle-hook methods fire as events arrive. Covered in [Realtime streams](../realtime/streams.md).

| Decorator | Applies to | What it does |
| --- | --- | --- |
| `@stream` | class | Marks a stream protocol handler. `@stream('name')` sets the mount name; `@stream({ scope })` picks Regional (L2) or Continental (L3). |
| `@connect` | method | Lifecycle hook: fires when a client connects (returns a `StreamOutbound` accept/reject). |
| `@message` | method | Lifecycle hook: fires on each inbound packet. |
| `@close` | method | Lifecycle hook: fires on a graceful close. |
| `@disconnect` | method | Lifecycle hook: fires on an abrupt transport loss. |

A server-side broadcast hook, `@channel`, is planned but not live in the current runtime. See [Channels](../realtime/channels.md) for the status and the working client-side `useChannel` hook you can use today.

## Background and daemon (L4)

Recurring, run-once-globally background work. `@daemon` runs on the single L4 leader. Covered in [Daemons](../background/daemons.md).

| Decorator | Applies to | What it does |
| --- | --- | --- |
| `@daemon` | class | Marks the single daemon class (at most one per project). May declare a zero-arg `onStart()` run once at boot. |
| `@scheduled` | method | Runs the method on a cadence: an interval (`'30s'`, `'5m'`, `'1h'`, `'1d'`) or a 5-field cron string (`'15 9 * * 1-5'`). |

## Database structure (shared)

Declare your database schema. These carry no tier of their own; they are compiled into every artifact so any tier can use them. Covered in the [database section](../database/README.md).

| Decorator | Applies to | What it does |
| --- | --- | --- |
| `@database` | class | Marks a class as a ToilDB database; each `@collection` field becomes a typed handle (`App.users.get(...)`). |
| `@collection` | field | Declares a field as a collection handle (`Documents` / `View` / `Unique` / `Counter` / `Events` / `Membership` / `Capacity`). |
| `@data` | class | Marks a class serializable: the compiler generates a binary codec so it can cross the wire and the database. See [Data types](../backend/data.md). |

## Database function kinds (data-access policy)

A **function kind** labels a function or method with *which* database operations it is allowed to issue, and the compiler enforces it (a read-only `@query` that tries to write is a compile error). Covered across the [database section](../database/README.md).

| Decorator | Applies to | What it does | Covered in |
| --- | --- | --- | --- |
| `@query` | function / method | Read-only data access. | [Database](../database/README.md) |
| `@action` | function / method | Read plus bounded writes and claims. | [Database](../database/README.md) |
| `@derive` | function / method | Publishes materialized views and rollups (a background materializer). | [@derive](../background/derive.md) |
| `@job` | function / method | Background work. | [Background work](../background/README.md) |
| `@admin` | function / method | Control-plane only operations. | [Database](../database/README.md) |

## Auth and structure

| Decorator | Applies to | What it does | Covered in |
| --- | --- | --- | --- |
| `@user` | class | Declares the authenticated-user shape; enables the typed `AuthService.getUser()`. At most one per project. | [Auth usage](../auth/usage.md) |
| `@main` | function | Marks a single top-level function as the module entry point (exported as the WASM `main`). Rarely written by hand: toiljs supplies the entry glue. | [Project structure](../getting-started/project-structure.md) |

## A note on low-level decorators

AssemblyScript (the language toilscript is built on) has its own low-level decorators such as `@inline`, `@unsafe`, and `@operator`. They tune how a symbol compiles and are for advanced library authors, not everyday app code. You will not need them to build a normal toiljs app, and they are out of scope here.

## Related

- [Compute tiers](./tiers.md): where each decorator's code runs (L1 to L4).
- [The type system](./types.md): the types (`u64`, `string`, `@data`) these decorators work with.
- [REST](../backend/rest.md) and [RPC](../backend/rpc.md): the L1 surfaces.
- [Realtime streams](../realtime/streams.md): the `@stream` surface.
- [Daemons](../background/daemons.md) and [@derive](../background/derive.md): L4 and background work.
- [The database (ToilDB)](../database/README.md): `@database`, `@collection`, and the function kinds.
- [Auth](../auth/README.md): `@auth` and `@user`.

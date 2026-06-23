# Server (toilscript → WebAssembly)

`server/` is the toilscript source, compiled to WebAssembly by `toilscript`.

- `server/main.ts`, the `@main` entry, exported as the WASM `main`.
- `server/index.ts`, your functions.
- `server/tsconfig.json`, extends `toilscript/std/assembly.json` (AssemblyScript/toilscript
  globals like `i32`, not the DOM), so editors resolve server types correctly.
- `npm run build:server` (or `npm run build`) emits `build/server/release.wasm` and
  regenerates `shared/server.ts` (the typed client RPC module).

## Typed RPC (`@data` / `@remote` / `@service`)

Tag server code and the build generates a typed client `Server` surface:

- `@data class X {}`, a serializable struct. Generates a client class with the same fields
  plus `encode`/`decode`; construct it on the client: `import { X } from "shared/server"`.
- `@remote function f(a: T): R`, a client-callable endpoint, becomes `Server.f(a)`.
- `@service class S { @remote m(...) {} }`, namespaces methods: `Server.s.m(...)`.

On the client, `Server` is a global (no import) and fully typed; every call is async
(`Promise<R>`). Inputs/outputs are scalars, arrays, or `@data` classes, both directions.

Note: the client↔server transport is not wired yet, so calling a `Server` method throws
until it lands; the typed surface + codec are generated and ready.

## HTTP REST (`@rest` / `@route`)

Tag a class `@rest` and its methods with a verb to expose a real HTTP API. Unlike RPC,
the generated client is working `fetch` code (it is just HTTP).

- `@rest("api") class Todos {}`, mounts the controller at `/api` (bare `@rest` → `/`).
- `@get("/todos/:id")` / `@post` / `@del` / `@put` / `@patch` / `@head` / `@options`, verb
  shortcuts; or `@route({ method: Methods.GET, path: "/todos", stream: DataStream.JSON })`.
- A method takes an optional `@data` body + an optional `ctx: RouteContext` (path params via
  `ctx.param("id")`, `ctx.query(...)`, `ctx.header(...)`). It returns either a `@data` type,
  which the compiler encodes per `stream` (`DataStream.JSON` default, or `DataStream.Binary`,
  lossless for large `u64`/bignum), or a `Response` for full control - custom status and
  headers, e.g. `Response.json(value.toJSON().toString()).setHeader("cache-control", "no-store")`
  or `Response.notFound()`. (The editor sees the compiler-injected `@data` `toJSON`/`encode`
  members via the toilscript plugin, so serializing into a `Response` is editor-clean.)

Each `@rest` class self-registers; dispatch them from your handler - it composes, it never
takes over `handle()`:

```ts
import { ToilHandler, Request, Response, Rest } from "toiljs/server/runtime";
export class App extends ToilHandler {
    public handle(req: Request): Response {
        const hit = Rest.dispatch(req); // try every @rest controller
        if (hit != null) return hit;
        return Response.notFound();     // your own logic / static fallback
    }
}
```

For a REST-only project, `Server.handler = () => new RestHandler()` does the same with no
boilerplate. On the client: `Server.REST.todos.getTodo({ params: { id } })` (see [client.md](./client.md)).

For the full reference (`@rest`/verb decorators, `RouteContext`, `Request`, `Response`,
dispatch + the 404 fallback) see [routing.md](./routing.md).

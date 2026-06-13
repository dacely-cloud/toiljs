# Routing

toiljs routing is decorator-driven. You write a controller class, annotate it
with `@rest` and its methods with verb decorators, and the ToilScript compiler
generates the dispatcher. Routes can take a typed body, read path params and the
raw request through a `RouteContext`, and return either a `Response` or a typed
value that is auto-encoded.

```ts
import { Response, RouteContext } from 'toiljs/server/runtime';

@rest('players')
class Players {
  @get('/:id')
  public get(ctx: RouteContext): Response {
    const id = ctx.param('id');
    return Response.json(`{"id":"${id}"}`);
  }

  @post('/')
  public create(input: NewPlayer): Player {
    // `input` is the decoded request body; returning a @data value JSON-encodes it
    return Player.from(input);
  }
}
```

## `@rest` controllers

`@rest` marks a class as a route controller and mounts it at a prefix.

```ts
@rest('api')                              // mounted at /api
@rest('/')               // or @rest('')  // mounted at the root
@rest({ stream: DataStream.Binary })      // root mount, binary codec by default
```

- The string argument is the mount prefix. `"api"`, `"/api"`, and `"api/"` all
  normalize to `/api`; `""` and `"/"` mean the root.
- The object form sets class-wide defaults. `stream: DataStream.Binary` makes
  every route in the class use the binary `@data` codec; the default is
  `DataStream.JSON`. Individual routes override this with `@route`.

The compiler injects, at module init, a registration that adds the controller to
the global `Rest` registry. Controllers dispatch in the order their modules are
loaded; routes within a controller try in declaration order, first match wins.

## Verb decorators

Each HTTP method has a decorator taking a single path string:

```ts
@get('/path')   @post('/path')   @put('/path')   @delete('/path')
@patch('/path') @head('/path')   @options('/path')
```

The full path is the controller prefix joined with the route path
(`prefix="/api"`, `@get("/todos/:id")` → `/api/todos/:id`).

### `@route` (explicit form)

`@route` is the general form; use it when you need to set the stream mode per
route or prefer an object:

```ts
@route({ method: Methods.POST, path: '/upload', stream: DataStream.Binary })
public upload(body: FileData): FileResult { /* ... */ }
```

`method` (from the `Methods` enum) and `path` are required; `stream` is
optional and overrides the controller default.

## Path parameters

A `:name` segment captures that URL segment. Read it with `ctx.param("name")`:

```ts
@get('/todos/:id/items/:itemId')
public getItem(ctx: RouteContext): Response {
  const id = ctx.param('id');
  const itemId = ctx.param('itemId');
  return Response.json(`{"todo":"${id}","item":"${itemId}"}`);
}
```

Matching is segment-exact: the request path must have the same number of
segments, static segments must match literally, and `:param` segments capture
the value. The query string is stripped before matching.

## Method parameters

A route method takes zero, one, or two parameters, classified by type:

- a `RouteContext` parameter receives the match context (path params, query,
  headers, raw body);
- any other type is treated as the **request body**, decoded as a `@data` value.

```ts
@get('/status')
public status(): StatusResponse { /* no body, no context */ }

@get('/user/:id')
public getUser(ctx: RouteContext): User { /* context only */ }

@post('/create')
public create(input: NewTodo): Todo { /* body only */ }

@post('/user/:id/score')
public addScore(input: ScoreDelta, ctx: RouteContext): Player {
  const id = ctx.param('id'); /* body AND context */
}
```

The body is decoded per the route's stream mode: in JSON mode from
`JSON.parse(ctx.text())`, in Binary mode from `Body.decode(req.body)`. See
[Data codec](./data.md).

## Return types

The compiler encodes the return value by its type:

| Return type | Result |
| --- | --- |
| `Response` | Returned as-is. Full control over status, headers, body. |
| `void` | `204 No Content`. |
| a `@data` type, JSON stream | `Response.json(value.toJSON().toString())`. |
| a `@data` type, Binary stream | `Response.bytes(value.encode())`. |

Returning a `Response` lets you set status, headers, cookies, and caching
directly; returning a typed value is the terse path when you just want the data
serialized.

## Data streams

Each route is either **JSON** (default) or **Binary**:

- **JSON** — the body is `JSON.parse`d and revived via the `@data` type's
  `fromJSON`; the response is the type's `toJSON()`. 64-bit-and-larger integers
  cross the wire as decimal strings (exact at any size). Best for endpoints a
  browser or third party calls directly.
- **Binary** — the body is `Body.decode(bytes)` and the response is
  `value.encode()`, using the deterministic `DataWriter`/`DataReader` codec. No
  precision loss, smaller, faster. Best for app-to-app and anything
  security-sensitive.

Set the mode on the controller (`@rest({ stream: DataStream.Binary })`) or per
route (`@route({ ..., stream: DataStream.Binary })`).

## Dispatch and the 404 fallback

At runtime the global `Rest` registry tries each controller in order:

```ts
const hit = Rest.dispatch(req); // Response | null
if (hit != null) return hit;    // first matching route's Response
return Response.unhandled();    // no route matched
```

`RestHandler` is a ready-made handler that does exactly this, so a REST-only app
needs no custom handler:

```ts
import { RestHandler } from 'toiljs/server/runtime';
Server.handler = () => new RestHandler();
```

`Response.unhandled()` is a `404` carrying the `x-toil-unhandled` marker header.
On the dev server and edge that marker means "no route matched here" and lets
the request fall through to the next layer (Vite in dev, static/SSR on the
edge). A deliberate `Response.notFound()` does **not** carry the marker and is
sent to the client verbatim.

---

## `Request`

The decoded incoming request (`server/runtime/request.ts`).

### Fields

| Field | Type | Notes |
| --- | --- | --- |
| `method` | `Method` | `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`, `UNKNOWN`. |
| `path` | `string` | Path including the query string. |
| `headers` | `Array<Header>` | Ordered; a `Header` is `{ name, value }`. |
| `body` | `Uint8Array` | Raw request body bytes. |

### Methods

| Method | Signature | Notes |
| --- | --- | --- |
| `header` | `header(name: string): string \| null` | Case-insensitive lookup, `null` if absent. |
| `cookies` | `cookies(): CookieMap` | Parses the `Cookie` header (percent-decoded values); cached for the request. |
| `cookie` | `cookie(name: string): string \| null` | A single cookie value, or `null`. |

The `Method` enum and `Header` class are exported from
`toiljs/server/runtime`.

## `RouteContext`

Passed to any route method that declares a `RouteContext` parameter
(`server/runtime/rest/RouteContext.ts`).

| Member | Signature | Notes |
| --- | --- | --- |
| `request` | `Request` | The raw incoming request. |
| `param` | `param(name: string): string` | Captured path param; `""` if absent. |
| `query` | `query(name: string): string` | Query-string value; `""` if absent. Not URL-decoded in v1. |
| `header` | `header(name: string): string \| null` | Case-insensitive request header. |
| `text` | `text(): string` | The request body decoded as UTF-8. |

## `Response`

The outgoing response builder (`server/runtime/response.ts`). Construct one with
a static factory, then chain instance methods (each returns the same `Response`).

### Constructor

```ts
new Response(status: u16, body: Uint8Array, headers: Array<Header> | null = null)
```

### Static factories

| Factory | Signature | Status | Content-Type |
| --- | --- | --- | --- |
| `Response.text` | `text(body: string, status: u16 = 200)` | 200 | `text/plain; charset=utf-8` |
| `Response.html` | `html(body: string, status: u16 = 200)` | 200 | `text/html; charset=utf-8` |
| `Response.json` | `json(body: string, status: u16 = 200)` | 200 | `application/json; charset=utf-8` |
| `Response.bytes` | `bytes(body: Uint8Array, status: u16 = 200)` | 200 | `application/octet-stream` |
| `Response.empty` | `empty(status: u16)` | custom | (none) |
| `Response.notFound` | `notFound()` | 404 | text |
| `Response.badRequest` | `badRequest(msg = 'bad request')` | 400 | text |
| `Response.internalError` | `internalError(msg = 'internal error')` | 500 | text |
| `Response.unhandled` | `unhandled()` | 404 | text + `x-toil-unhandled` marker |

`json` takes an already-serialized string; build it with `DataWriter`-free JSON
or a `@data` type's `toJSON().toString()`. For binary, prefer `bytes`.

### Instance methods

| Method | Signature | Notes |
| --- | --- | --- |
| `setHeader` | `setHeader(name: string, value: string): Response` | Appends a header (repeatable). |
| `setCookie` | `setCookie(cookie: Cookie): Response` | Appends a `Set-Cookie`. Call again for more. |
| `setCookieKV` | `setCookieKV(name: string, value: string): Response` | Shorthand for `setCookie(new Cookie(name, value))`. |
| `clearCookie` | `clearCookie(name: string, path = '/', domain = ''): Response` | Emits a deletion `Set-Cookie` (empty value, `Max-Age=0`). |
| `cache` | `cache(edgeTtlMinutes: u16, browserTtlSeconds: u32 = 0, privateScope: bool = false, allowAuth: bool = false): Response` | Marks the response cacheable. See [Caching](./caching.md). |
| `cacheFor` | `cacheFor(minutes: u16): Response` | Shorthand for `cache(minutes)` (edge only). |

```ts
return Response.json('{"id":42}')
  .setHeader('x-trace', traceId)
  .setCookie(Cookie.create('sid', token).httpOnly().secure())
  .cacheFor(5);
```

See [Cookies](./cookies.md) for the cookie builder, and [Caching](./caching.md)
for the cache directives.

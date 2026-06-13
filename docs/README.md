# toiljs docs

Reference documentation for the toiljs server runtime, the decorators the
ToilScript compiler understands, and the generated client surface.

The server runs as a WebAssembly module: your handler code is written in
ToilScript (a TypeScript/AssemblyScript dialect), compiled to wasm, and run one
fresh instance per request on both the dev server and the edge. Most of the
runtime is exposed two ways: as an ambient **global** (no import, like `crypto`)
and as a named export from `toiljs/server/runtime`.

## Guides

- [Getting started](./getting-started.md): project layout, `toiljs dev` /
  `toiljs build`, `main.ts` wiring, and the request lifecycle.

## Reference

- [Routing](./routing.md): `@rest` controllers, the `@get/@post/...` verb
  decorators and `@route`, path params, `RouteContext`, `Request`, `Response`,
  and how dispatch + the 404 fallback work.
- [Data codec (`@data`)](./data.md): the `@data` decorator and the
  `DataWriter` / `DataReader` binary codec (JSON vs Binary streams), with the
  exact wire format.
- [RPC and the generated client](./rpc.md): `@service` / `@remote`, the
  `--rpcModule` generated `shared/server.ts`, the typed `Server` proxy, and the
  REST fetch client.
- [Caching](./caching.md): the `@cache` decorator and `Response.cache(...)`
  (edge vs browser TTL, private scope, auth gating).
- [Auth, sessions, and `@user`](./auth.md): `@auth` route guards, the `@user`
  type, `AuthService` (post-quantum login, signed sessions, `getUser()`), and
  the client half.
- [Cookies](./cookies.md): the `Cookie` builder, the `Cookies` parser/codec,
  `CookieMap`, `SecureCookies` (HMAC signing and AES-256-GCM encryption), the
  `base64url` helpers, and the `Request` / `Response` integration.
- [Time](./time.md): `Time.nowMillis()` / `Time.nowSeconds()`, the host
  wall-clock binding.
- [SSR templates](./ssr.md): the `render` entrypoint, `SlotValues`,
  `HtmlBuilder`, and React-exact escaping.
- [Web Crypto](./crypto.md): the synchronous `crypto` global and
  `crypto.subtle` (digests, HMAC, AES-GCM, ECDSA, key import/derive), plus the
  ML-DSA-44 post-quantum verify import.

## Conventions

- **"Global, no import"** — a symbol marked `@global` in the runtime is in scope
  everywhere in a tenant without an `import`, exactly like `crypto`. The
  matching named export exists so editors resolve the type and so the module is
  pulled into every build. Either form works.
- **Binary, not JSON, on the hot paths** — request/response bodies, sessions,
  and cookies use the deterministic `DataWriter`/`DataReader` codec. JSON is
  available for `@rest` routes but binary is the default for anything
  performance- or security-sensitive.
- **One fresh instance per request** — guest memory is wiped between requests,
  so nothing persists in module globals across requests. Use a host-backed store
  for anything that must outlive a single request.

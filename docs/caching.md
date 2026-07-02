# Caching

toiljs can cache a response at the edge (shared, across users) and instruct the
browser to cache it too. You opt in per route, either declaratively with the
`@cache` decorator or imperatively with `Response.cache(...)`. The edge keys a
cached entry by host, method, path, and body hash, and honors a per-entry TTL.

## `@cache` decorator

Annotate a route method; the compiler appends the cache directive to whatever
`Response` the route returns, so it composes with every return shape (a
`Response`, a `void` 204, or an auto-encoded `@data` value).

```ts
@cache(60)              // 60 minutes at the edge
@cache(60, 300)         // + 5 minutes (300s) in the browser
@cache(60, 300, true)   // + private scope (per-user caches only)
@cache(60, 300, true, true) // + cache even for authenticated requests
@get('/leaderboard')
public top(): Standings { /* … */ }
```

Arguments must be integer or boolean literals; a non-literal argument makes the
decorator degrade safely to "not cached" rather than miscompile.

## `Response.cache(...)`

The same controls are available imperatively, which is what `@cache` lowers to:

```ts
public cache(
  edgeTtlMinutes: u16,
  browserTtlSeconds: u32 = 0,
  privateScope: bool = false,
  allowAuth: bool = false,
): Response
```

```ts
return Response.json(body).cache(60, 300);
```

`cacheFor(minutes)` is the common shorthand for "edge only, no browser caching":

```ts
return Response.bytes(blob).cacheFor(5);
```

## Parameters

| Parameter | Meaning |
| --- | --- |
| `edgeTtlMinutes` | How long the edge may serve the cached response. Clamped to a 24-hour maximum. |
| `browserTtlSeconds` | `max-age` for the browser. `0` (default) means the browser does not cache. |
| `privateScope` | Marks the response `private`: only per-user caches (the browser), never a shared edge/CDN cache. |
| `allowAuth` | Permit caching a response to an authenticated request. Off by default (see safety rails). |

## Safety rails

The cache layer refuses to store anything unsafe, regardless of the directive:

- **5xx** responses are never cached, a server error is transient, and `@cache`
  wraps the whole route, so a `@cache`d route that hits a blip returns its 500
  carrying the directive; caching it would serve the failure for the full TTL.
  **2xx, 3xx, and 4xx are cacheable** (a redirect or a `404`/`410` is a
  deterministic function of the request key);
- a response that sets a **`Set-Cookie`** is never cached;
- a response to an **authenticated** request is not cached unless you pass
  `allowAuth = true`, this prevents one user's personalized response from being
  served to another;
- the edge TTL is **clamped to 24 hours**.

Because `@auth` guards and body-decode run before the cache directive is applied,
an unauthorized request is rejected with 401 before anything is cached, and a
cached entry is only ever produced from a handler that actually ran.

Caching is **always opt-in.** A response with no `Dacely-Cache-Control` directive
(i.e. no `@cache` / `Response.cache(...)`) is never stored, there is no blind
"cache every GET" mode, because an automatic window cannot tell a personalized
response from a public one and would key it without a per-user component.

## Memory bounds and disk spill

The edge cache is per-core and hard-capped so it can never exhaust node memory.
It has two tiers:

- **RAM tier**, small, short-TTL responses. Bounded by a per-core byte budget
  (each core holds at most ~128 MB) plus an entry-count cap; an insert that would
  exceed the budget drops expired entries first, then evicts the soonest-to-expire
  ones. A response over ~256 KB does not go in the RAM tier.
- **Disk tier (spill)**, when the operator enables `--spill-dir`, a **big**
  (over the ~256 KB RAM cap) or **long-TTL** (≥ 10 min) cacheable response is
  written to disk instead and served back zero-RAM via a memory map, the same way
  static files are served. This keeps the RAM tier for the hot working set while
  still caching large bodies and long-lived entries. Writes (and unlinks) are
  offloaded to a sibling thread so they never stall the request path; a separate
  per-core disk budget caps total spilled bytes, with the same expiry + eviction.
  If spill is not enabled, a big response is simply not cached (reported as not
  stored by the `Dacely-Cache` tag).

From a tenant's point of view nothing changes: you still just set a
`Dacely-Cache-Control` directive (via `@cache` / `Response.cache(...)`). The edge
decides RAM vs disk; both honor the same TTL and the same safety rails above.
Expiry is enforced on read (a past-TTL entry is a miss) and reclaimed on the next
insert that needs room. Nothing persists across a process restart.

## Choosing TTLs

- Public, slow-changing data (a leaderboard, a catalog): a few minutes of edge
  TTL plus a short browser TTL removes most of the load.
- Per-user data: set `privateScope` so it never lands in a shared cache, and
  prefer a small or zero edge TTL.
- Anything with a `Set-Cookie` or behind `@auth`: leave it uncached unless you
  have thought through `allowAuth` and are certain the body is identical for
  every authorized caller.

# Rate limiting

The `@ratelimit` decorator throttles **any** `@rest` route — a login, a signup, a
public API, an email trigger, anything. It is enforced at the edge, before your
handler runs, and keyed by default on the connecting client's **unspoofable** IP,
so it works as an abuse / brute-force control out of the box.

It composes with the other route decorators and is independent of email or auth.

## Using `@ratelimit`

Add it to a route alongside the verb decorator:

```ts
import { Response, RouteContext } from 'toiljs/server/runtime';

@rest('auth')
class Auth {
    // At most 5 login attempts per 60 seconds per client IP.
    @ratelimit(RateLimit.SlidingWindow, 5, 60)
    @post('/login')
    login(ctx: RouteContext): Response {
        // ... only runs if under the limit ...
        return Response.text('ok\n');
    }
}
```

`@ratelimit(strategy, limit, window)`:

- **`strategy`** — a `RateLimit` value (ambient global, no import):
  `RateLimit.FixedWindow`, `RateLimit.SlidingWindow`, or `RateLimit.TokenBucket`.
- **`limit`** and **`window`** — integer literals whose meaning depends on the
  strategy (see below).

When a request is over the limit the edge returns **`429 Too Many Requests`**
with a **`Retry-After`** header (whole seconds), and your handler never runs. The
guard runs **before `@auth`**, so unauthenticated floods are limited too.

> Both arguments must be **integer literals** and the strategy a `RateLimit`
> member (or a bare integer tag). A malformed decorator emits no guard rather
> than miscompiling — the same fail-safe rule as `@cache`.

## Strategies

| Strategy | `limit`, `window` mean | Behavior |
| --- | --- | --- |
| `FixedWindow` | `limit` events per `window` seconds | Cheapest. Counts in aligned wall-clock buckets; a caller hammering a boundary can briefly get up to ~2× `limit` across two adjacent windows. |
| `SlidingWindow` | `limit` events per `window` seconds | Smooths the fixed-window boundary by weighting the previous window. Best general choice for "N per period". |
| `TokenBucket` | `limit` = burst size, `window` = refill **per second** | Allows an initial burst of `limit`, then a steady `window` tokens/sec. Good for bursty-but-bounded APIs. |

Examples:

```ts
// 100 requests / minute, smoothed:
@ratelimit(RateLimit.SlidingWindow, 100, 60)

// Burst of 20, then 5 per second sustained:
@ratelimit(RateLimit.TokenBucket, 20, 5)

// Exactly 3 per hour, cheapest:
@ratelimit(RateLimit.FixedWindow, 3, 3600)
```

## How requests are keyed

By default the limiter keys on the **client IP** — specifically the TCP peer
address the edge observed (`ctx.clientIp()`), **not** a header like
`X-Forwarded-For`, which a client can forge. That makes it a real abuse control:
a caller can't reset their bucket by spoofing a header.

The count is **exact across all 14 edge workers** (a given IP always maps to one
authoritative shard), so the limit is global per route, not per worker. Only
routes that opt in with `@ratelimit` ever pay anything — the lock-free fast path
for everything else is untouched.

> Each rate-limited route has its own independent limiter — a limit on `/login`
> does not consume the budget of `/signup`.

## Notes and limits

- **Route-level only.** Put `@ratelimit` on each route you want limited; there is
  no controller-wide form yet (unlike `@auth`).
- **Keyed on IP.** The decorator keys on the peer IP today. (A per-user / custom
  key — limiting by account instead of IP — exists in the runtime but is not yet
  exposed through the decorator.)
- **In dev.** `toiljs dev` runs a single-process mirror of the same three
  strategies, so a limited route behaves the same locally as on the edge.

## See also

- [Email](./email.md) — `@ratelimit` pairs well with email triggers (verification
  codes, password resets) to blunt abuse.
- [Auth, sessions, and `@user`](./auth.md) — `@ratelimit` runs before the `@auth`
  guard, so it protects the login itself.

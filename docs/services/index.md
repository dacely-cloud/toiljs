# Platform services

Your toiljs backend runs on the **Dacely edge**: a fleet of servers spread around the world that sit close to your users and run your compiled backend (a small, sandboxed WebAssembly program). "Platform services" are the batteries the edge includes so you do not have to run your own: response caching, rate limiting, secrets, email, analytics, cryptography, cookies, and a clock.

Each service is either a **route decorator** (an annotation you put above a route, like `@cache`) or an **ambient global** (an object you can use without importing it, like `Environment` or `Time`). Nothing here needs a separate server, a database you manage, or a third-party account for the basics.

## What each service is (and when you reach for it)

- **[Caching](./caching.md)** stores a copy of a response so the edge can hand it back instantly, without re-running your code. Reach for it when a route returns the same public data to many users (a leaderboard, a product listing, a marketing page). Skip it for anything personalized.
- **[Rate limiting](./ratelimit.md)** caps how often one client can hit a route. Reach for it on anything abusable: login, signup, "send me a code", a public write API. It stops brute-force and spam before your code even runs.
- **[Environment and secrets](./environment.md)** gives your app configuration (like a public API base URL) and secrets (like a payment provider key) that are set outside your code, so your compiled program never carries a credential. Reach for it any time you call a third party or need a value that differs between dev and production.
- **[Email](./email.md)** sends transactional email (verification codes, password resets, receipts) through a provider you configure once. Reach for it when your app needs to email a user.
- **[Analytics](./analytics.md)** counts requests, statuses, bytes, and cache hits per site, with no code changes. Reach for it to see traffic and cache effectiveness.
- **[Crypto](./crypto.md)** is a small, safe cryptography toolkit (hashing, HMAC, AES, random bytes) available with no import. Reach for it to sign or encrypt your own data. It is the engine under signed cookies.
- **[Cookies](./cookies.md)** is a complete cookie layer: read incoming cookies, set them on a response, and optionally sign or encrypt their values. Reach for it for preferences, feature flags, and any small piece of state you keep in the browser.
- **[Time](./time.md)** is the edge's clock: the current wall-clock time, read through a single blessed API. Reach for it whenever you need a timestamp or need to compute an expiry.

## Pick a service by what you need

| I want to... | Use | Shape |
| --- | --- | --- |
| Serve the same public response fast, without re-running code | [Caching](./caching.md) | `@cache(...)` / `Response.cache(...)` |
| Stop brute-force logins or spammy writes | [Rate limiting](./ratelimit.md) | `@ratelimit(...)` |
| Read a config value or a secret set outside my code | [Environment](./environment.md) | `Environment.get` / `getSecure` |
| Email a user a code or a receipt | [Email](./email.md) | `EmailService` |
| See traffic and cache-hit numbers per site | [Analytics](./analytics.md) | `Analytics` |
| Hash, sign, encrypt, or make random bytes | [Crypto](./crypto.md) | `crypto` |
| Remember a preference or flag in the browser | [Cookies](./cookies.md) | `Cookie` / `Cookies` / `SecureCookies` |
| Stamp or compare an instant in time | [Time](./time.md) | `Time.nowMillis()` / `Time.nowSeconds()` |
| Know who is logged in and protect routes | [Auth](../auth/index.md) | `@auth` / `@user` |

## How they fit together

Decorators and globals compose. A single route can be rate-limited, auth-guarded, and cached at once, and it can read a secret and stamp the time inside the handler:

```ts
import { Response, RouteContext } from 'toiljs/server/runtime';

@rest('api')
class Api {
    @ratelimit(RateLimit.SlidingWindow, 100, 60) // at most 100/min per client IP
    @cache(1)                                     // edge-cache for 1 minute
    @get('/status')
    status(ctx: RouteContext): Response {
        const region = Environment.get('REGION');       // config value, or null
        const now = Time.nowSeconds();                  // seconds since 1970
        return Response.json(`{"region":${JSON.stringify(region)},"at":${now}}`);
    }
}
```

The order of guards is fixed by the framework: rate limiting runs first (so floods are rejected cheaply), then auth, then your handler, and caching is applied to whatever your handler returns. You do not have to think about that order; it is safe by construction.

## Related

- [Every decorator, in one place](../concepts/decorators.md)
- [Configuration: build-time config vs runtime environment](../concepts/config.md)
- [Compute tiers (where your code runs)](../concepts/tiers.md)
- [Backend overview](../backend/index.md) and [HTTP routes](../backend/rest.md)
- [Auth, sessions, and `@user`](../auth/index.md)

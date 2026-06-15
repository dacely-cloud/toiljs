// RateLimitService + the `RateLimit` strategy enum: the server half of the
// `@ratelimit` route decorator, available as a no-import global (registered via
// the toilscript `--lib` mechanism, the same way `AuthService` and `crypto`
// are). The toilscript `@ratelimit(strategy, limit, window)` decorator lowers to
// a single `RateLimitService.guard(...)` call at the top of the route, before
// the `@auth` guard and the handler.
//
// The actual counting happens host-side in an EXACT limiter shared across all
// edge workers and keyed, by default, on the request's UNSPOOFABLE peer IP (the
// socket's remote address, never a forgeable header). Backed by the
// `ratelimit_check` host import (toil-backend `ratelimit_check_import.rs`, and
// the toiljs dev-server mock). A tenant that does not use `@ratelimit` never
// references this namespace, so AssemblyScript tree-shakes it and the module
// never imports `ratelimit_check` (only opt-in routes pay anything).

import { Response } from 'toiljs/server/runtime';

// Host import: account one event against the route's shared limiter. Args are
// `(route_id, strategy_tag, limit, window, key_ptr, key_len)`; the two param
// slots mean `(limit, window_secs)` for the window strategies and
// `(burst, refill_per_sec)` for the token bucket. Returns the remaining budget
// (`>= 0`, allowed) or a NEGATIVE `Retry-After` in seconds (denied). When
// `key_len` is 0 the host keys on the peer IP.
// @ts-ignore: decorator
@external('env', 'ratelimit_check')
declare function __toilRateLimitCheck(
    routeId: i32,
    strategy: i32,
    limit: i32,
    window: i32,
    keyPtr: usize,
    keyLen: i32,
): i32;

/**
 * Rate-limit strategy, the first argument to `@ratelimit(...)`. The numeric
 * values are the host's strategy tags (kept in sync with `Strategy` in
 * toil-backend `ratelimit.rs`); the toilscript decorator transform reads the
 * member by name, so reordering would only affect a bare-integer decorator arg.
 *
 *  - `FixedWindow`: at most `limit` events per `window` seconds. Cheapest; a
 *    caller hammering the boundary can briefly land up to ~2x `limit`.
 *  - `SlidingWindow`: weights the previous window to smooth that boundary burst.
 *  - `TokenBucket`: `limit` is the burst size, `window` the refill-per-second;
 *    allows an initial burst then a steady rate.
 */
export enum RateLimit {
    FixedWindow = 0,
    SlidingWindow = 1,
    TokenBucket = 2,
}

export namespace RateLimitService {
    /**
     * The `@ratelimit` decorator's guard. Accounts one event for this request
     * against the route's shared limiter, keyed on the UNSPOOFABLE peer IP.
     * Returns a `429 Too Many Requests` (with a `Retry-After` header) when over
     * the limit, or `null` to let the request proceed.
     */
    export function guard(routeId: i32, strategy: i32, limit: i32, window: i32): Response | null {
        const r = __toilRateLimitCheck(routeId, strategy, limit, window, 0, 0);
        return r >= 0 ? null : tooMany(-r);
    }

    /**
     * Like {@link guard} but keyed on a tenant-chosen identity `key` (e.g. an
     * authenticated user id) instead of the peer IP, for per-user limits. An
     * empty `key` falls back to the peer IP (host-side).
     */
    export function guardKeyed(
        routeId: i32,
        strategy: i32,
        limit: i32,
        window: i32,
        key: string,
    ): Response | null {
        const kb = Uint8Array.wrap(String.UTF8.encode(key));
        const r = __toilRateLimitCheck(routeId, strategy, limit, window, kb.dataStart, kb.length);
        return r >= 0 ? null : tooMany(-r);
    }

    /** A `429` response carrying the host-computed `Retry-After` (whole seconds). */
    function tooMany(retryAfterSecs: i32): Response {
        return Response.text('Too Many Requests\n', 429).setHeader(
            'Retry-After',
            retryAfterSecs.toString(),
        );
    }
}

/**
 * Dev-server rate limiter: a single-process mirror of the edge's
 * `toil-backend/src/ratelimit.rs` strategies, so a tenant using the
 * `@ratelimit(...)` decorator behaves the same under `toiljs dev` as on the
 * edge. The edge runs an EXACT limiter shared across 14 workers; dev is one
 * process, so a plain module-level registry is already "global".
 *
 * State lives here (module scope), NOT in the per-request DispatchState, because
 * a limiter must persist across requests (the dev server builds a fresh wasm
 * instance per request, exactly like the edge pools).
 */

/** Mirror of the host's strategy tags (`Strategy` in `ratelimit.rs`). */
export const STRATEGY_FIXED = 0;
export const STRATEGY_SLIDING = 1;
export const STRATEGY_TOKEN_BUCKET = 2;

interface KeyState {
    /** Token bucket: tokens * 1000 (sub-token refill without floats). */
    tokensMilli: number;
    /** Window strategies: aligned index of the current bucket. */
    window: number;
    cur: number;
    prev: number;
    lastMs: number;
}

interface RouteLimiter {
    strategy: number;
    /** `limit`/`window_secs` for windows; `burst`/`refill_per_sec` for the bucket. */
    a: number;
    b: number;
    keys: Map<string, KeyState>;
}

/** `(routeId) -> limiter`, created lazily with the route's first-seen params. */
const registry = new Map<number, RouteLimiter>();

/** Drop all limiter state (tests). Each dev wasm dispatch shares this module-level
 *  registry, so a test that fires many `@ratelimit`-decorated routes in one file
 *  would otherwise carry counts across cases; reset between cases for isolation. */
export function __resetRatelimitForTests(): void {
    registry.clear();
}

export interface DevDecision {
    allowed: boolean;
    /** Whole seconds to wait before retrying (>= 1 when denied, 0 when allowed). */
    retryAfterSecs: number;
}

/**
 * Account one event for `identity` against route `routeId` and return the
 * verdict. Mirrors `SharedLimiter::check` semantics. `now` is wall-clock ms
 * (`Date.now()`), which is fine for a single dev process.
 */
export function ratelimitCheck(
    routeId: number,
    strategy: number,
    limit: number,
    window: number,
    identity: string,
    now: number,
): DevDecision {
    let rl = registry.get(routeId);
    if (rl === undefined) {
        rl = { strategy, a: Math.max(1, limit), b: Math.max(1, window), keys: new Map() };
        registry.set(routeId, rl);
    }
    if (rl.strategy === STRATEGY_TOKEN_BUCKET) return checkBucket(rl, identity, now);
    return checkWindow(rl, identity, now, rl.strategy === STRATEGY_SLIDING);
}

function checkBucket(rl: RouteLimiter, key: string, now: number): DevDecision {
    const capMilli = rl.a * 1000;
    const refillPerSec = rl.b;
    let st = rl.keys.get(key);
    if (st === undefined) {
        st = { tokensMilli: capMilli, window: 0, cur: 0, prev: 0, lastMs: now };
        rl.keys.set(key, st);
    }
    const elapsed = Math.max(0, now - st.lastMs);
    st.tokensMilli = Math.min(capMilli, st.tokensMilli + elapsed * refillPerSec);
    st.lastMs = now;
    if (st.tokensMilli >= 1000) {
        st.tokensMilli -= 1000;
        return { allowed: true, retryAfterSecs: 0 };
    }
    const needed = 1000 - st.tokensMilli;
    const waitMs = Math.ceil(needed / refillPerSec);
    return { allowed: false, retryAfterSecs: Math.max(1, Math.ceil(waitMs / 1000)) };
}

function checkWindow(rl: RouteLimiter, key: string, now: number, sliding: boolean): DevDecision {
    const limit = rl.a;
    const windowMs = rl.b * 1000;
    const curWindow = Math.floor(now / windowMs);
    let st = rl.keys.get(key);
    if (st === undefined) {
        st = { tokensMilli: 0, window: curWindow, cur: 0, prev: 0, lastMs: now };
        rl.keys.set(key, st);
    }
    if (curWindow === st.window + 1) {
        st.prev = st.cur;
        st.cur = 0;
        st.window = curWindow;
    } else if (curWindow > st.window) {
        st.prev = 0;
        st.cur = 0;
        st.window = curWindow;
    }
    st.lastMs = now;
    const posInWindow = now % windowMs;
    const effective = sliding
        ? Math.floor((st.prev * (windowMs - posInWindow)) / windowMs) + st.cur
        : st.cur;
    if (effective < limit) {
        st.cur += 1;
        return { allowed: true, retryAfterSecs: 0 };
    }
    const waitMs = windowMs - posInWindow;
    return { allowed: false, retryAfterSecs: Math.max(1, Math.ceil(waitMs / 1000)) };
}

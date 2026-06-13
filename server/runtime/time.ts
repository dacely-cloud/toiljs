/**
 * `Time` — the guest's wall-clock, backed by the host's `Date.now()` binding
 * (`env.Date.now`). Both the edge (`toil-backend` `date_now_import.rs`) and the
 * dev server (`toiljs/src/devserver/host.ts`) provide it, so time behaves the
 * same in `toiljs dev` and in production.
 *
 * This is the toiljs-blessed way to read the clock; prefer it over a raw
 * `Date.now()` so the host boundary (and its single millisecond unit) is
 * explicit and easy to find. Like browser `Date.now()` it is WALL-CLOCK, not
 * monotonic: it can step backward across an NTP correction, so never use it to
 * measure elapsed time, only to stamp/compare absolute instants (session
 * `iat`/`exp`, challenge expiry, cache ages).
 *
 * Exposed as an ambient global (`@global`, usable with no import in a handler)
 * and re-exported from `toiljs/server/runtime`.
 */
@global
export class Time {
    /** Milliseconds since the Unix epoch (the host `Date.now()` value). */
    static nowMillis(): i64 {
        return <i64>Date.now();
    }

    /** Whole seconds since the Unix epoch (`nowMillis() / 1000`), the unit used
     *  for session and challenge timestamps. */
    static nowSeconds(): u64 {
        return <u64>(Date.now() / 1000);
    }
}

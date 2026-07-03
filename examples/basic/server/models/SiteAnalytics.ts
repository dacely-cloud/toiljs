/**
 * This site's own analytics snapshot, mapped from the toilscript `Analytics.self()` frame.
 *
 * This example deliberately returns only CURRENT state: the `live*` gauges (the instantaneous level
 * right now) and the request-window counters (usage in the current 1-minute and 24-hour rate-limit
 * windows, paired with the plan cap, where cap `0` = unlimited). It does NOT surface lifetime
 * cumulative `total*` counters. For historical, time-windowed values use the separate `SeriesData`
 * time-series (`/series`), which reads per-bucket history rather than an ever-growing running total.
 *
 * All fields are `u64` (the guest exposes `u64` getters, so the mapping needs zero casts).
 */
@data
export class SiteAnalytics {
    // --- Live gauges (current instantaneous level, right now, NOT a total) ---
    /** Streams currently connected right now. */
    liveConnectedStreams: u64 = 0;
    /** Wasm linear memory currently committed right now, in bytes. */
    liveCommittedMemoryBytes: u64 = 0;

    // --- Request windows: current rate-limit usage vs plan cap (cap 0 = unlimited) ---
    /** Requests used in the current 1-minute window. */
    requestsThisMinute: u64 = 0;
    /** Plan cap for the 1-minute window (0 = unlimited). */
    requestsThisMinuteCap: u64 = 0;
    /** Requests used in the current 24-hour window. */
    requestsToday: u64 = 0;
    /** Plan cap for the 24-hour window (0 = unlimited). */
    requestsTodayCap: u64 = 0;
}

/** One metric's historical TIME-SERIES for a range, from `Analytics.series(metric, range)`: the raw
 *  per-bucket totals (oldest→newest) plus the bucket width + newest-bucket end, so the client can draw a
 *  graph and derive per-second rates. This is per-bucket HISTORY: the right way to see a metric over time,
 *  instead of an ever-growing lifetime counter. Demonstrates the typed series API. */
@data
export class SeriesData {
    metric: i32 = 0;
    bucketSecs: u32 = 0;
    headMs: u64 = 0;
    points: i64[] = [];
}

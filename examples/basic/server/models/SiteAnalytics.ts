/**
 * This site's own analytics snapshot, mapped 1:1 from the toilscript `Analytics.self()` frame.
 *
 * Every `total*` field is an ALL-TIME CUMULATIVE COUNT — a running total since the site was first
 * seen, monotonically increasing, never reset by a query. They are NOT "last hour" or "last minute":
 * for time-windowed history use the separate `SeriesData` time-series (`/series`).
 *
 * All counter fields are `u64` (the guest exposes `u64` getters, so the mapping needs zero casts). The
 * `live*` gauges are the current instantaneous level (not a total). The request-window fields are the
 * current rate-limit bucket usage paired with the plan cap (cap `0` = unlimited).
 */
@data
export class SiteAnalytics {
    // --- Requests / L1 edge (all-time totals) ---
    /** Total HTTP requests served, all-time. */
    totalRequests: u64 = 0;
    /** Total response bytes sent from the L1 edge, all-time. */
    totalBytesOutL1: u64 = 0;
    /** Total request bytes received at the L1 edge, all-time. */
    totalBytesInL1: u64 = 0;
    /** Total 2xx responses, all-time. */
    totalStatus2xx: u64 = 0;
    /** Total 3xx responses, all-time. */
    totalStatus3xx: u64 = 0;
    /** Total 4xx responses, all-time. */
    totalStatus4xx: u64 = 0;
    /** Total 5xx responses, all-time. */
    totalStatus5xx: u64 = 0;
    /** Total static-asset hits (served without a wasm dispatch), all-time. */
    totalStaticHits: u64 = 0;
    /** Total wasm handler dispatches, all-time. */
    totalWasmDispatches: u64 = 0;
    /** Total requests rejected because the executor pool was full, all-time. */
    totalExecutorFullRejects: u64 = 0;
    /** Total requests rejected for an unknown host, all-time. */
    totalUnknownHostRejects: u64 = 0;
    /** Total requests rejected by rate limiting, all-time. */
    totalRateLimitedRejects: u64 = 0;
    /** Total wasm gas consumed across all dispatches, all-time. */
    totalGasUsed: u64 = 0;

    // --- Database (all-time totals) ---
    /** Total ToilDB operations issued, all-time. */
    totalDbOps: u64 = 0;
    /** Total ToilDB read operations, all-time. */
    totalDbReads: u64 = 0;
    /** Total ToilDB write operations, all-time. */
    totalDbWrites: u64 = 0;
    /** Total ToilDB operations that errored, all-time. */
    totalDbErrors: u64 = 0;
    /** Summed host-observed ToilDB op latency in nanoseconds, all-time (divide by totalDbOps for a mean). */
    totalDbLatencyNsSum: u64 = 0;

    // --- Streams / WebTransport (all-time totals) ---
    /** Total stream connections accepted, all-time. */
    totalStreamAccepts: u64 = 0;
    /** Total streams rejected because they landed on the wrong node, all-time. */
    totalStreamRejectWrongNode: u64 = 0;
    /** Total streams rejected for capacity, all-time. */
    totalStreamRejectCapacity: u64 = 0;
    /** Total streams rejected for a missing/invalid artifact, all-time. */
    totalStreamRejectArtifact: u64 = 0;
    /** Total streams rejected by the guest, all-time. */
    totalStreamRejectGuest: u64 = 0;
    /** Total stream guest traps, all-time. */
    totalStreamTraps: u64 = 0;
    /** Total streams closed for idle timeout, all-time. */
    totalStreamIdleTimeouts: u64 = 0;
    /** Total bytes received on streams, all-time. */
    totalStreamBytesIn: u64 = 0;
    /** Total bytes sent on streams, all-time. */
    totalStreamBytesOut: u64 = 0;
    /** Total stream backpressure events, all-time. */
    totalStreamBackpressureEvents: u64 = 0;
    /** Total clean stream closes, all-time. */
    totalStreamCloses: u64 = 0;
    /** Total stream disconnects (abrupt), all-time. */
    totalStreamDisconnects: u64 = 0;

    // --- Daemons / L4 (all-time totals) ---
    /** Total daemon starts, all-time. */
    totalDaemonStarts: u64 = 0;
    /** Total daemon start failures, all-time. */
    totalDaemonStartFailures: u64 = 0;
    /** Total daemon ticks fired, all-time. */
    totalDaemonTicksFired: u64 = 0;
    /** Total daemon ticks skipped because this node was not the leader, all-time. */
    totalDaemonTicksSkippedNotLeader: u64 = 0;
    /** Total daemon ticks that failed, all-time. */
    totalDaemonTicksFailed: u64 = 0;
    /** Total daemon leadership acquisitions, all-time. */
    totalDaemonLeaderAcquires: u64 = 0;
    /** Total daemon leadership fences (lost leadership), all-time. */
    totalDaemonLeaderFenced: u64 = 0;
    /** Total daemon outbound http_call attempts, all-time. */
    totalDaemonHttpCallAttempts: u64 = 0;
    /** Total daemon outbound http_call failures, all-time. */
    totalDaemonHttpCallFailures: u64 = 0;

    // --- Memory / email / cache (all-time totals) ---
    /** Total wasm linear-memory bytes grown, all-time. */
    totalMemGrownBytes: u64 = 0;
    /** Total emails sent, all-time. */
    totalEmails: u64 = 0;
    /** Total responses served from the edge cache, all-time. */
    totalCacheHits: u64 = 0;
    /** Total cacheable responses that missed the edge cache, all-time. */
    totalCacheMisses: u64 = 0;

    // --- Derived ---
    /** Fraction of cacheable responses served from cache: hits / (hits + misses), in 0..1. 0 when there
     *  were no cacheable responses. */
    cacheHitRatio: f64 = 0;

    // --- Live gauges (current instantaneous level, NOT a total) ---
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
 *  graph and derive per-second rates. This is per-bucket HISTORY — distinct from the all-time totals in
 *  `SiteAnalytics`. Demonstrates the typed series API. */
@data
export class SeriesData {
    metric: i32 = 0;
    bucketSecs: u32 = 0;
    headMs: u64 = 0;
    points: i64[] = [];
}

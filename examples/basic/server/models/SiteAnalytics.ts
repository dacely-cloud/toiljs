/** This site's own analytics, mapped from the toilscript `Analytics.self()` snapshot for the
 *  client. Counts + usage are i64; the rate-limit caps are i64 too (0 = unlimited). */
@data
export class SiteAnalytics {
    requests: i64 = 0;
    bytesOutL1: i64 = 0;
    bytesInL1: i64 = 0;
    status2xx: i64 = 0;
    wasmDispatches: i64 = 0;
    dbOps: i64 = 0;
    gasUsed: i64 = 0;
    connectedStreams: i64 = 0;
    committedMemory: i64 = 0;
    reqMinuteUsed: i64 = 0;
    reqMinuteCap: i64 = 0;
    reqDayUsed: i64 = 0;
    reqDayCap: i64 = 0;
}

/** One metric's historical time-series for a range, from `Analytics.series(metric, range)`: the raw
 *  per-bucket totals (oldest→newest) plus the bucket width + newest-bucket end, so the client can draw a
 *  graph and derive per-second rates. Demonstrates the typed series API. */
@data
export class SeriesData {
    metric: i32 = 0;
    bucketSecs: u32 = 0;
    headMs: u64 = 0;
    points: i64[] = [];
}

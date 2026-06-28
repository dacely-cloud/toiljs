/** This site's own analytics, mapped from the toilscript `Analytics.self()` snapshot for the
 *  client. Counts + usage are i64; the rate-limit caps are i64 too (0 = unlimited). */
@data
export class SiteAnalytics {
    requests: i64 = 0;
    bytesServed: i64 = 0;
    status2xx: i64 = 0;
    wasmDispatches: i64 = 0;
    dbOps: i64 = 0;
    reqMinuteUsed: i64 = 0;
    reqMinuteCap: i64 = 0;
    reqDayUsed: i64 = 0;
    reqDayCap: i64 = 0;
}

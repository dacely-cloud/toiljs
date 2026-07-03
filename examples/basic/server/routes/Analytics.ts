import { RouteContext } from 'toiljs/server/runtime';

import { SeriesData, SiteAnalytics } from '../models/SiteAnalytics';

/**
 * This site's own analytics, mounted at `/analytics`. On the client:
 *   await Server.REST.analytics.self()
 *
 * Reads the toilscript `Analytics.self()` snapshot (the per-domain metering counters + this
 * site's plan limits) and maps it into a `@data` response. A site can only read ITS OWN
 * analytics here; the privileged `dacely.com` domain additionally has `Analytics.site(domain)`
 * / `Analytics.listSites(...)`. Under `toiljs dev` the dev server returns sample data; at the
 * edge the SAME code reads the real metering. `Analytics` is a global (no import).
 */
@rest('analytics')
class AnalyticsRoutes {
    @get('/')
    public self(): SiteAnalytics {
        const stats = Analytics.self();
        const out = new SiteAnalytics();

        // Live gauges (current instantaneous level, not a cumulative total).
        out.liveConnectedStreams = stats.connectedStreams;
        out.liveCommittedMemoryBytes = stats.committedMemory;

        // Request windows: current usage vs plan cap (cap 0 = unlimited).
        out.requestsThisMinute = stats.reqMinuteUsed;
        out.requestsThisMinuteCap = stats.reqMinuteCap;
        out.requestsToday = stats.reqDayUsed;
        out.requestsTodayCap = stats.reqDayCap;

        // For historical, time-windowed values (per-bucket, not a lifetime total), see `/series` below.
        return out;
    }

    /// Any metric's historical time-series for a range, for graphs:
    ///   `await Server.REST.analytics.series({ query: { metric: MetricId, range: AnalyticsRange } })`
    /// `metric` is a `MetricId` (0..44), `range` an `AnalyticsRange` (0=1h .. 7=30d, default 24h). Returns
    /// the per-bucket totals oldest→newest; the client derives rates (value / bucketSecs) and draws them.
    @get('/series')
    public series(ctx: RouteContext): SeriesData {
        const metric = <MetricId>i32.parse(ctx.query('metric'));
        const rangeStr = ctx.query('range');
        const range = rangeStr.length > 0 ? <AnalyticsRange>i32.parse(rangeStr) : AnalyticsRange.H24;
        const s = Analytics.series(metric, range);
        const out = new SeriesData();
        out.metric = s.metric;
        out.bucketSecs = s.bucketSecs;
        out.headMs = s.headMs;
        out.points = s.points;
        return out;
    }
}

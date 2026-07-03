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

        // Requests / L1 edge (all-time totals). Guest getters are u64, model fields are u64: no casts.
        out.totalRequests = stats.requests;
        out.totalBytesOutL1 = stats.bytesOutL1;
        out.totalBytesInL1 = stats.bytesInL1;
        out.totalStatus2xx = stats.status2xx;
        out.totalStatus3xx = stats.status3xx;
        out.totalStatus4xx = stats.status4xx;
        out.totalStatus5xx = stats.status5xx;
        out.totalStaticHits = stats.staticHits;
        out.totalWasmDispatches = stats.wasmDispatches;
        out.totalExecutorFullRejects = stats.executorFullRejects;
        out.totalUnknownHostRejects = stats.unknownHostRejects;
        out.totalRateLimitedRejects = stats.rateLimitedRejects;
        out.totalGasUsed = stats.gasUsed;

        // Database (all-time totals).
        out.totalDbOps = stats.dbOps;
        out.totalDbReads = stats.dbReads;
        out.totalDbWrites = stats.dbWrites;
        out.totalDbErrors = stats.dbErrors;
        out.totalDbLatencyNsSum = stats.dbLatencyNsSum;

        // Streams / WebTransport (all-time totals).
        out.totalStreamAccepts = stats.streamAccepts;
        out.totalStreamRejectWrongNode = stats.streamRejectWrongNode;
        out.totalStreamRejectCapacity = stats.streamRejectCapacity;
        out.totalStreamRejectArtifact = stats.streamRejectArtifact;
        out.totalStreamRejectGuest = stats.streamRejectGuest;
        out.totalStreamTraps = stats.streamTraps;
        out.totalStreamIdleTimeouts = stats.streamIdleTimeouts;
        out.totalStreamBytesIn = stats.streamBytesIn;
        out.totalStreamBytesOut = stats.streamBytesOut;
        out.totalStreamBackpressureEvents = stats.streamBackpressureEvents;
        out.totalStreamCloses = stats.streamCloses;
        out.totalStreamDisconnects = stats.streamDisconnects;

        // Daemons / L4 (all-time totals).
        out.totalDaemonStarts = stats.daemonStarts;
        out.totalDaemonStartFailures = stats.daemonStartFailures;
        out.totalDaemonTicksFired = stats.daemonTicksFired;
        out.totalDaemonTicksSkippedNotLeader = stats.daemonTicksSkippedNotLeader;
        out.totalDaemonTicksFailed = stats.daemonTicksFailed;
        out.totalDaemonLeaderAcquires = stats.daemonLeaderAcquires;
        out.totalDaemonLeaderFenced = stats.daemonLeaderFenced;
        out.totalDaemonHttpCallAttempts = stats.daemonHttpCallAttempts;
        out.totalDaemonHttpCallFailures = stats.daemonHttpCallFailures;

        // Memory / email / cache (all-time totals) + the derived cache-hit ratio.
        out.totalMemGrownBytes = stats.memGrownBytes;
        out.totalEmails = stats.emails;
        out.totalCacheHits = stats.cacheHits;
        out.totalCacheMisses = stats.cacheMisses;
        out.cacheHitRatio = stats.cacheRatio;

        // Live gauges (current level, not a total).
        out.liveConnectedStreams = stats.connectedStreams;
        out.liveCommittedMemoryBytes = stats.committedMemory;

        // Request windows: current usage vs plan cap (cap 0 = unlimited).
        out.requestsThisMinute = stats.reqMinuteUsed;
        out.requestsThisMinuteCap = stats.reqMinuteCap;
        out.requestsToday = stats.reqDayUsed;
        out.requestsTodayCap = stats.reqDayCap;

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

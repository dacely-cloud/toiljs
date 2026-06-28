import { SiteAnalytics } from '../models/SiteAnalytics';

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
        const s = Analytics.self();
        const r = new SiteAnalytics();
        r.requests = s.lifetime.has('requests') ? s.lifetime.get('requests') : 0;
        r.bytesServed = s.lifetime.has('bytes_served') ? s.lifetime.get('bytes_served') : 0;
        r.status2xx = s.lifetime.has('status_2xx') ? s.lifetime.get('status_2xx') : 0;
        r.wasmDispatches = s.lifetime.has('wasm_dispatches') ? s.lifetime.get('wasm_dispatches') : 0;
        r.dbOps = s.lifetime.has('db_ops') ? s.lifetime.get('db_ops') : 0;
        r.reqMinuteUsed = s.reqMinuteUsed;
        r.reqMinuteCap = <i64>s.reqMinuteCap;
        r.reqDayUsed = s.reqDayUsed;
        r.reqDayCap = <i64>s.reqDayCap;
        return r;
    }
}

// Demo of the per-domain Analytics API. `Server.REST.analytics.self()` is the real, typed
// fetch client generated from the `@rest` controller in server/routes/Analytics.ts; the route
// reads the toilscript `Analytics.self()` snapshot. Under `toiljs dev` the dev server returns
// sample data; at the edge the same code reads the real metering.
import { useState } from 'react';

import { SiteAnalytics } from 'shared/server';

export const metadata: Toil.Metadata = {
    title: 'Analytics',
    description: "This site's own analytics via the toilscript Analytics.self() API."
};

export default function AnalyticsDemo() {
    const [stats, setStats] = useState<SiteAnalytics | null>(null);
    const [err, setErr] = useState('');

    const load = async () => {
        try {
            setStats(await Server.REST.analytics.self());
            setErr('');
        } catch (e) {
            setErr(parseError(e));
        }
    };

    const cap = (used: bigint, max: bigint) => `${used} / ${max ? String(max) : '∞'}`;

    return (
        <main>
            <h1>Analytics</h1>
            <p>
                <code>Server.REST.analytics.self()</code> reads this site's own analytics via the toilscript{' '}
                <code>Analytics.self()</code> API (the per-domain metering counters + plan limits). Under{' '}
                <code>toiljs dev</code> you get sample data; at the edge it is the real metering, with the same code.
            </p>
            <button onClick={load}>Load my site analytics</button>
            {err && <p>{err}</p>}
            {stats && (
                <ul>
                    <li>requests: {String(stats.requests)}</li>
                    <li>bytes served: {String(stats.bytesServed)}</li>
                    <li>2xx responses: {String(stats.status2xx)}</li>
                    <li>wasm dispatches: {String(stats.wasmDispatches)}</li>
                    <li>db ops: {String(stats.dbOps)}</li>
                    <li>requests this minute: {cap(stats.reqMinuteUsed, stats.reqMinuteCap)}</li>
                    <li>requests today: {cap(stats.reqDayUsed, stats.reqDayCap)}</li>
                </ul>
            )}
            <p>
                <Toil.Link href="/">Back home</Toil.Link>
            </p>
        </main>
    );
}

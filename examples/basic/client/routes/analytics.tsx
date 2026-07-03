// Demo of the per-domain Analytics API + the historical time-series (graphs).
//
//   Server.REST.analytics.self()                                -> the current snapshot (typed getters)
//   Server.REST.analytics.series({ query: { metric, range } })  -> a metric's history for a range
//
// Both are the real, typed fetch clients generated from the `@rest` controller in
// server/routes/Analytics.ts, which reads the toilscript `Analytics.self()` / `Analytics.series()` API.
// Under `toiljs dev` the dev server returns sample data; at the edge the SAME code reads the real
// metering rings. The chart is a self-contained inline SVG (no chart library).
import { useEffect, useState } from 'react';

import { SeriesData, SiteAnalytics } from 'shared/server';

export const metadata: Toil.Metadata = {
    title: 'Analytics',
    description: "This site's own analytics + historical graphs via the toilscript Analytics API."
};

// MetricId (mirrors the server enum). Only the graph-worthy ones are listed for the picker.
const METRICS = [
    { id: 0, label: 'Requests', unit: 'count' },
    { id: 1, label: 'Bytes out (L1)', unit: 'bytes' },
    { id: 2, label: 'Bytes in (L1)', unit: 'bytes' },
    { id: 12, label: 'Gas used', unit: 'count' },
    { id: 13, label: 'DB ops', unit: 'count' },
    { id: 26, label: 'Stream bytes out', unit: 'bytes' },
    { id: 39, label: 'Memory bandwidth', unit: 'bytes' },
    { id: 41, label: 'Connected streams', unit: 'count' },
    { id: 43, label: 'Committed memory', unit: 'bytes' }
] as const;

// AnalyticsRange (mirrors the server enum).
const RANGES = [
    { id: 0, label: '1h' },
    { id: 1, label: '6h' },
    { id: 3, label: '24h' },
    { id: 5, label: '7d' },
    { id: 7, label: '30d' }
] as const;

type Unit = 'count' | 'bytes';

function fmt(n: number, unit: Unit): string {
    if (unit === 'bytes') {
        const u = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        while (n >= 1024 && i < u.length - 1) {
            n /= 1024;
            i++;
        }
        return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
    }
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** A dependency-free SVG line chart of the per-second rate (value / bucketSecs). */
function LineChart({ points, bucketSecs, unit }: { points: number[]; bucketSecs: number; unit: Unit }) {
    const W = 640;
    const H = 220;
    const pad = 40;
    const rate = points.map((v) => (bucketSecs > 0 ? v / bucketSecs : 0));
    const max = Math.max(1, ...rate);
    const n = rate.length;
    const x = (i: number) => pad + (n <= 1 ? 0 : (i / (n - 1)) * (W - 2 * pad));
    const y = (v: number) => H - pad - (v / max) * (H - 2 * pad);
    const line = rate.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${line} L${x(n - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;

    return (
        <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            role="img"
            aria-label="time series chart"
            style={{ maxWidth: W, background: '#0b0f19', borderRadius: 8 }}>
            <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#33415580" />
            <line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="#33415580" />
            <text x={6} y={pad + 4} fill="#94a3b8" fontSize={11}>
                {fmt(max, unit)}/s
            </text>
            <text x={6} y={H - pad} fill="#94a3b8" fontSize={11}>
                0
            </text>
            {n > 0 && <path d={area} fill="#38bdf822" />}
            {n > 1 && <path d={line} fill="none" stroke="#38bdf8" strokeWidth={2} />}
            {n === 1 && <circle cx={x(0)} cy={y(rate[0])} r={3} fill="#38bdf8" />}
        </svg>
    );
}

export default function AnalyticsDemo() {
    const [stats, setStats] = useState<SiteAnalytics | null>(null);
    const [series, setSeries] = useState<SeriesData | null>(null);
    const [metric, setMetric] = useState(0);
    const [range, setRange] = useState(3);
    const [err, setErr] = useState('');

    const loadStats = async () => {
        try {
            setStats(await Server.REST.analyticsRoutes.self());
            setErr('');
        } catch (e) {
            setErr(parseError(e));
        }
    };

    // Refetch the graph whenever the metric or range changes.
    useEffect(() => {
        Server.REST.analyticsRoutes
            .series({ query: { metric, range } })
            .then(setSeries)
            .catch((e: unknown) => setErr(parseError(e)));
    }, [metric, range]);

    const cap = (used: bigint, max: bigint) => `${used} / ${max ? String(max) : '∞'}`;
    const meta = METRICS.find((m) => m.id === metric) ?? METRICS[0];
    const points = series ? series.points.map(Number) : [];

    return (
        <main>
            <h1>Analytics</h1>
            <p>
                <code>analytics.self()</code> reads this site's snapshot; <code>analytics.series(metric, range)</code>{' '}
                reads the historical rings (30-day retention). Under <code>toiljs dev</code> you get sample data; at
                the edge it is the real metering, same code.
            </p>

            <section>
                <h2>History</h2>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                    <label>
                        Metric{' '}
                        <select value={metric} onChange={(e) => setMetric(Number(e.currentTarget.value))}>
                            {METRICS.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Range{' '}
                        <select value={range} onChange={(e) => setRange(Number(e.currentTarget.value))}>
                            {RANGES.map((r) => (
                                <option key={r.id} value={r.id}>
                                    {r.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <span style={{ color: '#64748b' }}>
                        {series ? `${series.points.length} buckets · ${series.bucketSecs}s each` : ''}
                    </span>
                </div>
                <LineChart points={points} bucketSecs={series?.bucketSecs ?? 3600} unit={meta.unit} />
            </section>

            <section style={{ marginTop: 24 }}>
                <h2>Snapshot</h2>
                <button onClick={loadStats}>Load my site analytics</button>
                {err && <p style={{ color: '#f87171' }}>{err}</p>}
                {stats && (
                    <ul>
                        <li>requests: {String(stats.requests)}</li>
                        <li>bytes out (L1): {String(stats.bytesOutL1)}</li>
                        <li>bytes in (L1): {String(stats.bytesInL1)}</li>
                        <li>gas used: {String(stats.gasUsed)}</li>
                        <li>2xx responses: {String(stats.status2xx)}</li>
                        <li>db ops: {String(stats.dbOps)}</li>
                        <li>connected streams (live): {String(stats.connectedStreams)}</li>
                        <li>committed memory (live): {fmt(Number(stats.committedMemory), 'bytes')}</li>
                        <li>requests this minute: {cap(stats.reqMinuteUsed, stats.reqMinuteCap)}</li>
                        <li>requests today: {cap(stats.reqDayUsed, stats.reqDayCap)}</li>
                    </ul>
                )}
            </section>

            <p style={{ marginTop: 24 }}>
                <Toil.Link href="/">Back home</Toil.Link>
            </p>
        </main>
    );
}

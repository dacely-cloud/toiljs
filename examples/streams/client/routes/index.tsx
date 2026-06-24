// The home page, served by the L1 request tier (server/main.ts -> release.wasm).
// It explains the three deployment tiers this example compiles into - see the README
// and the server/ source for the full story.

interface TierProps {
    tag: string;
    title: string;
    entry: string;
    surface: string;
    artifact: string;
    blurb: string;
}

async function test(): void {
    const stream = await Server.STREAM.echo.connect();


}

function Tier({ tag, title, entry, surface, artifact, blurb }: TierProps) {
    return (
        <section
            style={{
                border: '1px solid #e2e2e2',
                borderRadius: 10,
                padding: '1rem 1.25rem',
                margin: '1rem 0'
            }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem' }}>
                <span
                    style={{
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        background: '#111',
                        color: '#fff',
                        borderRadius: 6,
                        padding: '0.15rem 0.45rem'
                    }}>
                    {tag}
                </span>
                <h2 style={{ margin: 0, fontSize: '1.15rem' }}>{title}</h2>
                <code style={{ marginLeft: 'auto', color: '#888' }}>{artifact}</code>
            </div>
            <p style={{ margin: '0.6rem 0 0.3rem' }}>{blurb}</p>
            <p style={{ margin: 0, fontSize: '0.85rem', color: '#666' }}>
                <code>{entry}</code> &nbsp;&middot;&nbsp; <code>{surface}</code>
            </p>
        </section>
    );
}

export default function Home() {

    return (
        <main style={{ maxWidth: 760, margin: '0 auto', padding: '2rem 1.25rem', lineHeight: 1.5 }}>
            <h1>Toil streams example</h1>
            <p>
                One source tree, compiled into <strong>three WebAssembly artifacts</strong> - one per deployment tier of
                the Toil edge. This page is served by the L1 request tier; the stream and daemon tiers run as their own
                resident boxes.
            </p>

            <Tier
                tag="L1"
                title="Request"
                entry="server/main.ts"
                surface="@rest / @service / @remote"
                artifact="release.wasm"
                blurb="A fresh handler per request, anywhere on the edge. It serves this page."
            />
            <Tier
                tag="L2/L3"
                title="Stream"
                entry="server/main.stream.ts + streams/Echo.ts"
                surface="@stream"
                artifact="release-stream.wasm"
                blurb="A resident wasm box per WebTransport connection, pinned to one worker via QUIC connection-id steering. Its state survives every @connect / @message / @close."
            />
            <Tier
                tag="L4"
                title="Daemon"
                entry="server/main.daemon.ts + daemon/Jobs.ts"
                surface="@daemon / @scheduled"
                artifact="release-cold.wasm"
                blurb="Exactly one leader-elected box per domain (warm standby, at-most-once failover) firing @scheduled tasks on their cadence."
            />

            <p style={{ marginTop: '2rem', color: '#666' }}>
                Run <code>npm run build</code>, then <code>ls build/server/*.wasm</code> to see the three artifacts the
                single build produced. See the README for the full mapping.
            </p>
        </main>
    );
}

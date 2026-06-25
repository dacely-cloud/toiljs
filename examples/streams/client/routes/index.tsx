// The home page, served by the L1 request tier (server/main.ts -> release.wasm).
// It explains the three deployment tiers this example compiles into - see the README
// and the server/ source for the full story.

import { useState } from 'react';

import type { StreamChannel } from 'toiljs/client';

interface TierProps {
    tag: string;
    title: string;
    entry: string;
    surface: string;
    artifact: string;
    blurb: string;
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

/** Live `Server.Stream.Echo` demo: open a real browser WebTransport session to the stream edge,
 *  send a message, and show the echo the resident `@stream` box returns. */
function EchoDemo() {
    const [origin, setOrigin] = useState('https://wt.dacely.com');
    const [msg, setMsg] = useState('hello from Server.Stream');
    const [log, setLog] = useState<string[]>([]);
    const [channel, setChannel] = useState<StreamChannel | null>(null);
    const add = (line: string): void => setLog((l) => [...l, line]);
    const cell = { font: 'inherit', padding: '4px 8px' } as const;

    async function connect(): Promise<void> {
        // Point the runtime at the WebTransport edge; without this it falls back to same-origin dev WS.
        (globalThis as Record<string, unknown>).__TOIL_STREAM_ORIGIN__ = origin;
        // shared/server.ts (generated from the @stream catalog) attaches `globalThis.__toilStream` and,
        // via toiljs/client, sets `globalThis.Server`. Load it lazily, browser-only, so SSR never
        // evaluates its `globalThis.location` access.
        await import('../../shared/server');
        add('connecting -> ' + origin + '/echo');
        try {
            const c = await Server.Stream.Echo.connect();
            add('session READY');
            c.onMessage((bytes) => add('<- echo: ' + new TextDecoder().decode(bytes)));
            c.onClose((code) => add('closed (0x' + code.toString(16) + ')'));
            setChannel(c);
        } catch (e) {
            add('connect failed: ' + String(e));
        }
    }

    function send(): void {
        if (channel === null) return;
        channel.send(new TextEncoder().encode(msg));
        add('-> sent: ' + msg);
    }

    return (
        <section
            style={{
                border: '1px solid #cdd6dd',
                borderRadius: 10,
                padding: '1rem 1.25rem',
                margin: '1.5rem 0',
                background: '#fafdff'
            }}>
            <h2 style={{ margin: 0, fontSize: '1.15rem' }}>
                Live <code>Server.Stream.Echo</code>
            </h2>
            <p style={{ margin: '0.5rem 0', fontSize: '0.85rem', color: '#666' }}>
                Opens a real WebTransport session to the stream edge and echoes a message back through the resident box.
                Needs the node reachable at the origin below over UDP/443 (not via a Cloudflare tunnel).
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                <input
                    style={{ ...cell, flex: '1 1 260px' }}
                    value={origin}
                    onChange={(e) => setOrigin(e.target.value)}
                />
                <input style={{ ...cell, flex: '1 1 200px' }} value={msg} onChange={(e) => setMsg(e.target.value)} />
            </div>
            <button style={cell} onClick={() => void connect()}>
                Connect
            </button>{' '}
            <button style={cell} onClick={send} disabled={channel === null}>
                Send
            </button>
            <pre
                style={{
                    background: '#111',
                    color: '#ddd',
                    padding: 10,
                    borderRadius: 6,
                    marginTop: '0.75rem',
                    minHeight: 90,
                    whiteSpace: 'pre-wrap'
                }}>
                {log.join('\n')}
            </pre>
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

            <EchoDemo />

            <p style={{ marginTop: '2rem', color: '#666' }}>
                Run <code>npm run build</code>, then <code>ls build/server/*.wasm</code> to see the three artifacts the
                single build produced. See the README for the full mapping.
            </p>
        </main>
    );
}

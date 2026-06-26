export const metadata: Toil.Metadata = {
    title: 'Realtime socket',
    description: 'A raw WebSocket channel to a resident @stream box: send a frame, watch the box reply.'
};

// Toil.useChannel opens a raw WebSocket to a @stream route (here /echo, served by the Echo @stream box in
// server/streams/Echo.ts). It tracks `connected`, collects every reply in `messages`, and exposes `send`;
// it reconnects automatically. The dev server bridges the socket to the resident box (each frame ->
// @message -> reply), and the Toil edge does the same over a real WebTransport session.
export default function RealtimeDemo() {
    const chat = Toil.useChannel({ path: '/echo' });
    const text = (m: string | ArrayBuffer): string => (typeof m === 'string' ? m : new TextDecoder().decode(m));
    return (
        <main>
            <h1>Realtime socket</h1>
            <p>
                Connection: <strong>{chat.connected ? 'connected' : 'disconnected'}</strong>, replies:{' '}
                <strong>{chat.messages.length}</strong>.
            </p>
            <p>
                <button type="button" onClick={() => chat.send('ping')}>
                    Send ping
                </button>
            </p>
            {chat.messages.length > 0 && (
                <ul>
                    {chat.messages.map((m, i) => (
                        <li key={i}>
                            <code>{text(m)}</code>
                        </li>
                    ))}
                </ul>
            )}
            <p style={{ opacity: 0.6 }}>
                <code>
                    Toil.useChannel({'{'} path: '/echo' {'}'})
                </code>{' '}
                - the resident box replies <code>pong #N</code>; the advancing counter proves its state survives every
                frame.
            </p>
            <p>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

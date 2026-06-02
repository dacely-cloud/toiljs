export const metadata: Toil.Metadata = {
    title: 'Realtime',
    description: 'A typed WebSocket channel to the server with connect, reconnect, and message decoding.'
};

// Toil.useChannel opens a WebSocket to the server (default path /_toil), tracks `connected`, collects
// `messages`, and exposes `send`. It reconnects automatically. With no server socket running the demo
// simply shows "disconnected", the API is the same once the server handles the channel.
export default function RealtimeDemo() {
    const chat = Toil.useChannel({ path: '/_toil' });
    return (
        <main>
            <h1>Realtime</h1>
            <p>
                Connection: <strong>{chat.connected ? 'connected' : 'disconnected'}</strong>, messages received:{' '}
                <strong>{chat.messages.length}</strong>.
            </p>
            <p>
                <button type="button" onClick={() => chat.send('ping')}>
                    Send ping
                </button>
            </p>
            <p style={{ opacity: 0.6 }}>
                <code>
                    const chat = Toil.useChannel({'{'} path: '/_toil' {'}'})
                </code>
                , connect, reconnect, and decoding are handled for you.
            </p>
            <p>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

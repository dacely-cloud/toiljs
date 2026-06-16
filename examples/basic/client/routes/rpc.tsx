// Demo of the generated, typed `Server` RPC surface (see ../../shared/server.ts, emitted
// by the server build from `@service`/`@remote`). `Server` is global (no import) and typed
// from the server: `Server.ping(n)` (free `@remote`) and `Server.stats.playerCount()` (a
// `@service` method). Transport is not wired yet, so a real call throws; this page shows
// the typing and reports the stub error via the global `parseError`.
import { useState } from 'react';

export default function RpcDemo() {
    const [result, setResult] = useState('not called');

    // Scalar in / scalar out: Server.ping is typed (n: number) => Promise<number>.
    const onPing = async () => {
        try {
            const next = await Server.ping(10);
            setResult(`ping -> ${next}`);
        } catch (err) {
            setResult(parseError(err));
        }
    };

    // A @service method: namespaced under its service key.
    const onCount = async () => {
        try {
            const n = await Server.stats.playerCount();
            setResult(`stats.playerCount -> ${n}`);
        } catch (err) {
            setResult(parseError(err));
        }
    };

    return (
        <main>
            <h1>RPC</h1>
            <p>
                <code>Server</code> (RPC) is typed from the server build, no import. Calling throws until the transport
                lands. For working server calls today, use the REST client.
            </p>
            <button onClick={onPing}>Server.ping(10)</button>{' '}
            <button onClick={onCount}>Server.stats.playerCount()</button>
            <p>{result}</p>
            <Toil.Link href="/rest">See the REST demo</Toil.Link>, <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}

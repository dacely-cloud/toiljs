// Demo of the server-side Web Crypto API. In the toilscript server, `crypto` is a global
// (no import) and synchronous, the same SubtleCrypto-style API the browser has, running in
// the server wasm via metered host functions. These buttons call the server's `/api/hash`
// (sha256 of the path) and `/api/uuid` (randomUUID) routes from `server/HelloHandler.ts`.
// Needs the server running to respond.
import { useState } from 'react';

export const metadata: Toil.Metadata = {
    title: 'Web Crypto',
    description: 'Server-side Web Crypto (SubtleCrypto): synchronous, global, running in the server wasm.'
};

export default function CryptoDemo() {
    const [log, setLog] = useState<string[]>([]);
    const note = (line: string): void => setLog((prev) => [line, ...prev].slice(0, 8));

    const onHash = async (): Promise<void> => {
        try {
            const res = await fetch('/api/hash');
            const body = (await res.json()) as { sha256: string };
            note('sha256("/api/hash") = ' + body.sha256);
        } catch (err) {
            note('error: ' + String(err));
        }
    };

    const onUuid = async (): Promise<void> => {
        try {
            const res = await fetch('/api/uuid');
            note('randomUUID = ' + (await res.text()).trim());
        } catch (err) {
            note('error: ' + String(err));
        }
    };

    return (
        <main>
            <h1>Web Crypto</h1>
            <p>
                <code>crypto</code> is a global in the server (no import), synchronous, the same SubtleCrypto-style API
                as the browser, running in the server wasm via metered host functions. These buttons call the
                server&apos;s <code>/api/hash</code> and <code>/api/uuid</code> routes (see{' '}
                <code>server/HelloHandler.ts</code>). Needs the server running to respond.
            </p>
            <button onClick={onHash}>SHA-256</button> <button onClick={onUuid}>random UUID</button>
            <ul style={{ marginTop: 16, listStyle: 'none', padding: 0 }}>
                {log.map((line, i) => (
                    <li key={i} style={{ fontFamily: 'monospace', fontSize: '0.85rem', opacity: 0.85 }}>
                        {line}
                    </li>
                ))}
            </ul>
            <p style={{ marginTop: 24 }}>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

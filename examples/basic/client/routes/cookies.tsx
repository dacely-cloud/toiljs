// Demo of the server-side cookie library. In the toilscript server, `Cookie`,
// `Cookies`, and `SecureCookies` are globals (no import), the full RFC 6265bis
// surface plus HMAC signing and AES-256-GCM encryption, running in the server wasm.
// These controls call the `/api/cookies/*` routes in `server/core/AppHandler.ts`.
// Needs the server running to respond.
import { useState, type CSSProperties } from 'react';

import { useBrowserValue } from '../lib/useBrowserValue';

export const metadata: Toil.Metadata = {
    title: 'Cookies',
    description:
        'Server-side cookies as a global: the Cookie builder, parsing, HMAC signing, and AES-256-GCM encryption, running in the server wasm.',
};

interface SetResp {
    visits: number;
    emitted: string[];
}
interface InspectResp {
    raw: string;
    count: number;
    cookies: Record<string, string>;
    session: string | null;
    secret: string | null;
}
interface SealResp {
    value: string;
    signed: string;
    unsigned: string | null;
    encrypted: string;
    decrypted: string | null;
    tamperVerifies: boolean;
}

const mono: CSSProperties = { fontFamily: 'monospace', fontSize: '0.82rem', wordBreak: 'break-all' };
const card: CSSProperties = {
    border: '1px solid #1d2530',
    borderRadius: 8,
    padding: '12px 16px',
    margin: '12px 0',
    background: '#0c1218',
};
const label: CSSProperties = { opacity: 0.7, fontSize: '0.8rem', marginTop: 6 };

/** The cookies JS can read (HttpOnly cookies are absent from `document.cookie`). */
function readJsCookies(): string {
    return document.cookie || '(nothing visible to JS)';
}

export default function CookiesDemo() {
    const [gallery, setGallery] = useState<Record<string, string> | null>(null);
    const [setResp, setSetResp] = useState<SetResp | null>(null);
    const [inspect, setInspect] = useState<InspectResp | null>(null);
    const [cleared, setCleared] = useState<string[] | null>(null);
    const [seal, setSeal] = useState<SealResp | null>(null);
    const [sealInput, setSealInput] = useState('hello toiljs');
    const [err, setErr] = useState('');

    // Hydration-safe: '' on the server and first paint, the live `document.cookie`
    // after mount; `readJs()` re-reads after a Set/Clear/Seal action.
    const [jsCookies, readJs] = useBrowserValue(readJsCookies, '');

    const guard = async (fn: () => Promise<void>): Promise<void> => {
        setErr('');
        try {
            await fn();
        } catch (e) {
            setErr(String(e));
        }
    };

    const getJSON = async <T,>(url: string): Promise<T> => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} -> ${String(res.status)}`);
        return (await res.json()) as T;
    };

    const showGallery = (): Promise<void> =>
        guard(async () => setGallery(await getJSON<Record<string, string>>('/api/cookies/gallery')));
    const doSet = (): Promise<void> =>
        guard(async () => {
            setSetResp(await getJSON<SetResp>('/api/cookies/set'));
            readJs();
        });
    const doInspect = (): Promise<void> =>
        guard(async () => setInspect(await getJSON<InspectResp>('/api/cookies/inspect')));
    const doClear = (): Promise<void> =>
        guard(async () => {
            const r = await getJSON<{ cleared: string[] }>('/api/cookies/clear');
            setCleared(r.cleared);
            setInspect(null);
            setSetResp(null);
            readJs();
        });
    const doSeal = (): Promise<void> =>
        guard(async () =>
            setSeal(await getJSON<SealResp>('/api/cookies/seal?v=' + encodeURIComponent(sealInput))),
        );

    return (
        <main style={{ maxWidth: 760 }}>
            <h1>Cookies</h1>
            <p>
                <code>Cookie</code>, <code>Cookies</code>, and <code>SecureCookies</code> are globals in
                the server (no import), exactly like <code>crypto</code>: the full RFC 6265bis surface
                plus HMAC signing and AES-256-GCM encryption, running in the server wasm. See{' '}
                <code>server/core/AppHandler.ts</code>. Needs the server running (<code>toiljs dev</code>).
            </p>

            {err ? <p style={{ color: '#ff6b6b', ...mono }}>{err}</p> : null}

            <h2>1. Everything you can do</h2>
            <p>Every attribute and cookie type, with the exact `Set-Cookie` string it serializes to.</p>
            <button onClick={showGallery}>Show the gallery</button>
            {gallery ? (
                <div style={card}>
                    {Object.keys(gallery).map((k) => (
                        <div key={k}>
                            <div style={label}>{k}</div>
                            <div style={mono}>{gallery[k]}</div>
                        </div>
                    ))}
                </div>
            ) : null}

            <h2>2. Set cookies</h2>
            <p>
                Stores three real cookies: a plain <code>visits</code> counter, an HMAC-signed{' '}
                <code>__Host-session</code>, and an AES-GCM-encrypted <code>secret</code>. The last two
                are <code>HttpOnly</code>, so JavaScript cannot read them, only the server can.
            </p>
            <button onClick={doSet}>Set cookies</button>
            {setResp ? (
                <div style={card}>
                    <div>visit #{setResp.visits}</div>
                    {setResp.emitted.map((c, i) => (
                        <div key={i} style={mono}>
                            {c}
                        </div>
                    ))}
                </div>
            ) : null}

            <h2>3. What JS sees vs what the server sees</h2>
            <p>
                <code>document.cookie</code> only exposes non-<code>HttpOnly</code> cookies, so the
                signed session and encrypted secret are hidden from it. The server parses all of them
                and verifies/decrypts the protected ones.
            </p>
            <button onClick={readJs}>Read document.cookie</button>{' '}
            <button onClick={doInspect}>Ask the server (/inspect)</button>
            <div style={card}>
                <div style={label}>document.cookie (browser / JS)</div>
                <div style={mono}>{jsCookies}</div>
            </div>
            {inspect ? (
                <div style={card}>
                    <div style={label}>server view (/api/cookies/inspect)</div>
                    <div style={mono}>raw: {inspect.raw || '(none)'}</div>
                    <div style={mono}>parsed: {JSON.stringify(inspect.cookies)}</div>
                    <div style={mono}>session (HMAC-verified): {inspect.session ?? 'null (missing or tampered)'}</div>
                    <div style={mono}>secret (AES-GCM-decrypted): {inspect.secret ?? 'null (missing or tampered)'}</div>
                </div>
            ) : null}

            <h2>4. Clear</h2>
            <button onClick={doClear}>Clear the demo cookies</button>
            {cleared ? (
                <div style={card}>
                    {cleared.map((c, i) => (
                        <div key={i} style={mono}>
                            {c}
                        </div>
                    ))}
                </div>
            ) : null}

            <h2>5. Sign &amp; encrypt a value</h2>
            <p>
                <code>SecureCookies.signed(key)</code> (HMAC-SHA256, readable but tamper-proof) and{' '}
                <code>SecureCookies.encrypted(key)</code> (AES-256-GCM, confidential). Both bind the
                value to the cookie name, and a tampered signature fails to verify.
            </p>
            <input
                value={sealInput}
                onChange={(e) => setSealInput(e.target.value)}
                style={{ padding: 6, marginRight: 8, minWidth: 220 }}
            />
            <button onClick={doSeal}>Seal it</button>
            {seal ? (
                <div style={card}>
                    <div style={mono}>value: {seal.value}</div>
                    <div style={mono}>signed: {seal.signed}</div>
                    <div style={mono}>unsigned: {seal.unsigned ?? 'null'}</div>
                    <div style={mono}>encrypted: {seal.encrypted}</div>
                    <div style={mono}>decrypted: {seal.decrypted ?? 'null'}</div>
                    <div style={mono}>tampered signature verifies? {String(seal.tamperVerifies)}</div>
                </div>
            ) : null}

            <p style={{ marginTop: 24 }}>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

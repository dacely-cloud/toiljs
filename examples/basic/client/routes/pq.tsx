// Post-quantum identity demo. The browser derives an ML-DSA-44 keypair from a
// password (Argon2id -> ML-DSA-44.KeyGen, all client-side, the password never
// leaves), signs a login challenge, and POSTs the public key + signature to the
// edge, which verifies it via the `crypto.mldsa_verify` host import
// (server/routes/PqDemo.ts). The secret key is wiped right after signing.
//
// This shows the post-quantum crypto end-to-end (derive -> sign -> edge verify)
// in one request. It is NOT the production login (no server-issued challenge, so
// no anti-replay) -- see Auth.login / server/routes/Auth.ts and docs/auth.md.
import { useCallback, useState } from 'react';

import { Auth, type IdentityProof } from 'toiljs/client';

export const metadata: Toil.Metadata = {
    title: 'Post-quantum auth',
    description:
        'ML-DSA-44 (FIPS 204) end-to-end: the browser derives a keypair from a password (Argon2id) and signs; the edge verifies via crypto.mldsa_verify. No secret ever leaves the client.',
};

type Result = { ok: boolean; status: number; text: string } | { error: string };

async function postVerify(envelope: Uint8Array): Promise<Result> {
    try {
        const res = await fetch('/pq/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: envelope as BodyInit,
        });
        return { ok: res.ok, status: res.status, text: (await res.text()).trim() };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

/** Flip one byte of the signature (last field) so the proof must fail. */
function tamper(envelope: Uint8Array): Uint8Array {
    const out = envelope.slice();
    if (out.length > 0) out[out.length - 1] ^= 0x01;
    return out;
}

export default function Pq(): React.JSX.Element {
    const [username, setUsername] = useState('ada');
    const [password, setPassword] = useState('correct horse battery staple');
    const [busy, setBusy] = useState(false);
    const [proof, setProof] = useState<IdentityProof | null>(null);
    const [result, setResult] = useState<Result | null>(null);

    const prove = useCallback(
        async (doTamper: boolean) => {
            setBusy(true);
            setResult(null);
            try {
                const p = await Auth.proveIdentity(username, password);
                setProof(p);
                setResult(await postVerify(doTamper ? tamper(p.envelope) : p.envelope));
            } catch (e) {
                setResult({ error: e instanceof Error ? e.message : String(e) });
            } finally {
                setBusy(false);
            }
        },
        [username, password],
    );

    return (
        <main style={{ maxWidth: 680 }}>
            <h1>Post-quantum identity</h1>
            <p>
                The browser stretches the password with <strong>Argon2id</strong>, expands it into an{' '}
                <strong>ML-DSA-44</strong> (FIPS 204) keypair, and signs a login challenge. Only the public key and
                the signature are sent; the edge verifies them with the <code>crypto.mldsa_verify</code> host import.
                The password and secret key never leave this tab.
            </p>

            <div style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
                <label>
                    Username
                    <input value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: '100%' }} />
                </label>
                <label>
                    Password
                    <input
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        style={{ width: '100%' }}
                    />
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => prove(false)} disabled={busy}>
                        {busy ? 'Deriving + signing…' : 'Prove identity'}
                    </button>
                    <button onClick={() => prove(true)} disabled={busy} title="Flip a signature byte: must fail">
                        Tamper, then verify
                    </button>
                </div>
            </div>

            {proof && (
                <p style={{ marginTop: 16, fontFamily: 'monospace', fontSize: '0.85rem', opacity: 0.8 }}>
                    Argon2id: {proof.deriveMs} ms · public key {proof.publicKeyHex}… (1312 B) · signature{' '}
                    {proof.signatureLen} B
                </p>
            )}

            {result && (
                <p
                    style={{
                        marginTop: 8,
                        fontWeight: 600,
                        color: 'error' in result ? '#c0392b' : result.ok ? '#1e8449' : '#c0392b',
                    }}
                >
                    {'error' in result
                        ? `error: ${result.error}`
                        : `POST /pq/verify -> ${result.status}: ${result.text}`}
                </p>
            )}

            <p style={{ marginTop: 24, opacity: 0.7, fontSize: '0.9rem' }}>
                This is a stateless crypto demo, not the production login (no server-issued challenge, so no
                anti-replay). The full register/login protocol is in <code>server/routes/Auth.ts</code>; sessions and{' '}
                <code>getUser()</code> are on the <Toil.Link href="/auth">Auth</Toil.Link> page.
            </p>
            <p>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

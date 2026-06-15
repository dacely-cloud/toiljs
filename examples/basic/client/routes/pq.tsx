// Post-quantum identity demo, challenge-response. The browser fetches a
// SERVER-issued challenge (a fresh nonce the edge HMAC-signs into a token),
// derives an ML-DSA-44 keypair from a password (Argon2id, all client-side, the
// password never leaves), signs the message built from the server's nonce, and
// POSTs the public key + signature + token to the edge, which re-opens the token
// (rejecting a forged/expired one) and verifies via `crypto.mldsa_verify`
// (server/routes/PqDemo.ts). The secret key is wiped right after signing.
//
// The nonce is server-chosen and tamper-proof, so a client cannot pre-sign or
// swap in its own. It still isn't the full production login (no single-use
// consume -> within the TTL a captured proof could be replayed; that needs a
// store) -- see Auth.login / server/routes/Auth.ts and docs/auth.md.
import { useCallback, useState } from 'react';

import { Auth, type IdentityProof } from 'toiljs/client';
import { Account } from 'shared/server';

import { useBrowserValue } from '../lib/useBrowserValue';

/** Read the readable companion cookie under either name (HTTP `toil_user` or
 * HTTPS `__Secure-toil_user`) and decode it. Display-only / untrusted. */
function readCompanion(): Account | null {
    const pairs = (document.cookie || '').split('; ');
    let raw: string | null = null;
    for (const p of pairs) {
        const eq = p.indexOf('=');
        const name = eq > 0 ? p.slice(0, eq) : '';
        if (name === 'toil_user' || name === '__Secure-toil_user') {
            raw = p.slice(eq + 1);
            break;
        }
    }

    if (raw === null) return null;
    try {
        let b = raw.replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        const bin = atob(b);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return Account.decode(bytes);
    } catch {
        return null;
    }
}

interface VerifiedUser {
    username: string;
    admin: boolean;
    score: string;
}

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
    const [verified, setVerified] = useState<VerifiedUser | null | 'none'>(null);

    // Hydration-safe: null on the server and first paint, the live companion
    // cookie after mount; `refreshCompanion()` re-reads after a PQ login.
    const [companion, refreshCompanion] = useBrowserValue(readCompanion, null);

    const prove = useCallback(
        async (doTamper: boolean) => {
            setBusy(true);
            setResult(null);
            setVerified(null);
            try {
                const p = await Auth.proveIdentity(username, password);
                setProof(p);
                // A real (untampered) proof logs in: /pq/verify mints the session.
                const r = await postVerify(doTamper ? tamper(p.envelope) : p.envelope);
                setResult(r);
                refreshCompanion();
            } catch (e) {
                setResult({ error: e instanceof Error ? e.message : String(e) });
            } finally {
                setBusy(false);
            }
        },
        [username, password, refreshCompanion],
    );

    /** Hit the @auth-guarded /session/me to prove the PQ login established a
     *  real session the server re-verifies. */
    const checkSession = useCallback(async () => {
        setBusy(true);
        try {
            const res = await fetch('/session/me', { credentials: 'same-origin' });
            if (res.status === 401) {
                setVerified('none');
                return;
            }

            const r = new DataReader(new Uint8Array(await res.arrayBuffer()));
            setVerified({ username: r.readString(), admin: r.readBool(), score: r.readU64().toString() });
        } finally {
            setBusy(false);
        }
    }, []);

    const logout = useCallback(async () => {
        setBusy(true);
        try {
            await fetch('/session/logout', { method: 'POST', credentials: 'same-origin' });
            refreshCompanion();
            setVerified(null);
            setResult(null);
        } finally {
            setBusy(false);
        }
    }, [refreshCompanion]);

    return (
        <main style={{ maxWidth: 680 }}>
            <h1>Post-quantum login</h1>
            <p>
                The edge issues a fresh, HMAC-signed <strong>challenge</strong> (a server-chosen nonce). The browser
                stretches the password with <strong>Argon2id</strong>, expands it into an <strong>ML-DSA-44</strong>{' '}
                (FIPS 204) keypair, and signs the message built from <em>that</em> nonce. Only the public key,
                signature, and the server's token are sent back; the edge re-opens the token and verifies with the{' '}
                <code>crypto.mldsa_verify</code> host import. The password and secret key never leave this tab.
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
                        {busy ? 'Deriving + signing…' : 'Log in'}
                    </button>
                    <button onClick={() => prove(true)} disabled={busy} title="Flip a signature byte: must fail">
                        Tamper, then verify
                    </button>
                </div>
                <p style={{ fontSize: '0.8rem', opacity: 0.7, margin: 0 }}>
                    Demo: pre-filled <code>ada</code> / <code>correct horse battery staple</code> &mdash; but any
                    username + password works. The keypair is derived from the <strong>username AND password</strong>:
                    Argon2id is salted with the username (<code>sha256(&quot;pq-demo|&quot; + username)</code>), so two
                    people with the same password get different identities. Same username+password always maps to the
                    same keypair (no signup). What a real app adds (and this stateless demo can&apos;t, without a
                    store): binding a username to a <em>registered</em> key, so here the username is self-asserted
                    &mdash; <code>server/routes/Auth.ts</code>.
                </p>
            </div>

            {proof && (
                <p style={{ marginTop: 16, fontFamily: 'monospace', fontSize: '0.85rem', opacity: 0.8 }}>
                    server nonce {proof.nonceHex}… · Argon2id {proof.deriveMs} ms · public key {proof.publicKeyHex}…
                    (1312 B) · signature {proof.signatureLen} B
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

            {companion && (
                <section style={{ marginTop: 20, borderTop: '1px solid #8884', paddingTop: 16 }}>
                    <h2 style={{ fontSize: '1.05rem' }}>
                        Signed in &mdash; the post-quantum proof minted a session
                    </h2>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                        <div style={{ border: '1px solid #2563ff55', borderRadius: 8, padding: '0.6rem 0.9rem' }}>
                            <strong>getUser(), client</strong>
                            <div style={{ fontSize: '0.8em', opacity: 0.7 }}>readable companion, untrusted</div>
                            <pre>
                                {JSON.stringify(
                                    { username: companion.username, admin: companion.admin, score: String(companion.score) },
                                    null,
                                    2,
                                )}
                            </pre>
                        </div>
                        <div style={{ border: '1px solid #7c3aed55', borderRadius: 8, padding: '0.6rem 0.9rem' }}>
                            <strong>
                                /session/me, <code>@auth</code>
                            </strong>
                            <div style={{ fontSize: '0.8em', opacity: 0.7 }}>the server re-verifies the session</div>
                            {verified === null ? (
                                <p>not checked</p>
                            ) : verified === 'none' ? (
                                <p>401, no session</p>
                            ) : (
                                <pre>{JSON.stringify(verified, null, 2)}</pre>
                            )}
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button onClick={checkSession} disabled={busy}>
                            Check /session/me (@auth)
                        </button>
                        <button onClick={logout} disabled={busy}>
                            Logout
                        </button>
                    </div>
                </section>
            )}

            <p style={{ marginTop: 24, opacity: 0.7, fontSize: '0.9rem' }}>
                This is the full login: the password derives an ML-DSA-44 keypair client-side, the edge verifies the
                signature, and on success it mints the signed <code>__Host-toil_sess</code> session, so every{' '}
                <code>@auth</code> route (like <code>/session/me</code>) and <code>getUser()</code> now recognise you.
                The challenge is server-issued and tamper-proof but stateless, so it has no single-use consume yet
                (within the TTL a captured proof could be replayed; the atomic-consume shape is in{' '}
                <code>server/routes/Auth.ts</code>). Plain sessions are on the{' '}
                <Toil.Link href="/auth">Auth</Toil.Link> page.
            </p>
            <p>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

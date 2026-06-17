// Post-quantum auth demo, the full toil PQ-Auth chain (the password never leaves the
// tab). REGISTER: the browser blinds the password through the server-keyed OPRF,
// stretches the OPRF output with Argon2id into an ML-DSA-44 keypair, and submits
// only the public key + a proof-of-possession. LOG IN: a challenge-response that
// also runs an ML-KEM-768 encapsulation; the server proves its own identity with
// a confirmation tag the client verifies (mutual auth). On success the edge mints
// the signed `__Host-toil_sess` session. See server/routes/Auth.ts +
// server/globals/auth.ts (the AuthService global) and toiljs/client (Auth.*).
import { useCallback, useState } from 'react';

import { Auth } from 'toiljs/client';
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
        'A server-keyed-salt OPRF + ML-DSA-44 (FIPS 204) auth + ML-KEM-768 (FIPS 203) mutual auth. The password never leaves the browser.',
};

type Note = { kind: 'ok' | 'err'; text: string } | null;

export default function Pq(): React.JSX.Element {
    const [username, setUsername] = useState('ada');
    const [password, setPassword] = useState('correct horse battery staple');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<Note>(null);
    const [verified, setVerified] = useState<VerifiedUser | null | 'none'>(null);

    // Hydration-safe: null on the server and first paint, the live companion
    // cookie after mount; `refreshCompanion()` re-reads after a PQ login.
    const [companion, refreshCompanion] = useBrowserValue(readCompanion, null);

    const doRegister = useCallback(async () => {
        setBusy(true);
        setNote(null);
        setVerified(null);
        try {
            await Auth.register(username, password);
            setNote({ kind: 'ok', text: 'registered — the server stored only your public key + PoP. Now log in.' });
        } catch (e) {
            setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
        } finally {
            setBusy(false);
        }
    }, [username, password]);

    const doLogin = useCallback(async () => {
        setBusy(true);
        setNote(null);
        setVerified(null);
        try {
            // Resolves only if the server's mutual-auth confirmation tag verified.
            await Auth.login(username, password);
            setNote({ kind: 'ok', text: 'logged in — mutual auth verified (server proved it holds the KEM key).' });
            refreshCompanion();
        } catch (e) {
            setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
        } finally {
            setBusy(false);
        }
    }, [username, password, refreshCompanion]);

    /** Hit the @auth-guarded /session/me to prove the login established a real
     *  session the server re-verifies. */
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
            setNote(null);
        } finally {
            setBusy(false);
        }
    }, [refreshCompanion]);

    return (
        <main style={{ maxWidth: 680 }}>
            <h1>Post-quantum login</h1>
            <p>
                <strong>Register</strong> blinds the password through the server-keyed <strong>OPRF</strong> (so a
                breached server can&apos;t precompute a password dictionary), stretches the result with{' '}
                <strong>Argon2id</strong> into an <strong>ML-DSA-44</strong> keypair, and sends only the public key plus
                a proof-of-possession. <strong>Log in</strong> signs a server challenge and runs an{' '}
                <strong>ML-KEM-768</strong> key encapsulation; the edge decapsulates and returns a confirmation tag the
                browser verifies, so the <em>server</em> is authenticated too. The password and secret key never leave
                this tab.
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
                    <button onClick={doRegister} disabled={busy}>
                        {busy ? 'Working…' : 'Register'}
                    </button>
                    <button onClick={doLogin} disabled={busy}>
                        {busy ? 'Working…' : 'Log in'}
                    </button>
                </div>
                <p style={{ fontSize: '0.8rem', opacity: 0.7, margin: 0 }}>
                    Demo: pre-filled <code>ada</code> / <code>correct horse battery staple</code>. Register once, then
                    log in. A wrong password fails at login (the derived key won&apos;t match the stored one). Storage is
                    the DEV-only in-process KV (<code>src/devserver/kv.ts</code>); a real deployment wires an atomic
                    store — <code>server/routes/Auth.ts</code>.
                </p>
            </div>

            {note && (
                <p style={{ marginTop: 8, fontWeight: 600, color: note.kind === 'ok' ? '#1e8449' : '#c0392b' }}>
                    {note.text}
                </p>
            )}

            {companion && (
                <section style={{ marginTop: 20, borderTop: '1px solid #8884', paddingTop: 16 }}>
                    <h2 style={{ fontSize: '1.05rem' }}>Signed in &mdash; the post-quantum login minted a session</h2>
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
                This is the full augmented-PAKE chain: OPRF keyed salt + ML-DSA client auth + ML-KEM mutual auth, with an
                atomic single-use challenge consume. The OPRF layer is classical ristretto255 (the one non-PQ piece);
                auth and key agreement are post-quantum. Plain sessions are on the{' '}
                <Toil.Link href="/auth">Auth</Toil.Link> page.
            </p>
            <p>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

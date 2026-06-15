// Auth / session demo. Drives the server's `@user` / `@auth` / `AuthService`
// surface (server/routes/Session.ts): a dev login mints an HMAC-signed
// `__Host-toil_sess` cookie (+ a readable `__Secure-toil_user` companion), the
// guarded `/session/me` route returns the verified user, and logout clears both.
//
// Two views of "who am I": `getUser()` reads the readable companion cookie with
// no round-trip (instant, but UNTRUSTED, a client can forge it), while
// `GET /session/me` is the server re-verifying the signed session (trusted).
// The full post-quantum register/login (ML-DSA-44) needs an account store and is
// stubbed in server/routes/Auth.ts; see docs/auth.md.
import { useCallback, useState } from 'react';

import { Account } from 'shared/server';

import { useBrowserValue } from '../lib/useBrowserValue';

/** Read one cookie value from `document.cookie`, or null. */
function readCookie(name: string): string | null {
    const pairs = (document.cookie || '').split('; ');
    for (const p of pairs) {
        const eq = p.indexOf('=');
        if (eq > 0 && p.slice(0, eq) === name) return p.slice(eq + 1);
    }

    return null;
}

function b64urlDecode(s: string): Uint8Array | null {
    try {
        let b = s.replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        const bin = atob(b);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

/** Decode the readable companion cookie under either name (HTTP `toil_user` or
 * HTTPS `__Secure-toil_user`). UNTRUSTED, display-only, like the generated
 * `getUser()` (which only knows the HTTPS name). */
function readCompanion(): Account | null {
    const raw = readCookie('toil_user') ?? readCookie('__Secure-toil_user');
    if (raw === null) return null;
    const bytes = b64urlDecode(raw);
    if (bytes === null) return null;
    try {
        return Account.decode(bytes);
    } catch {
        return null;
    }
}

export const metadata: Toil.Metadata = {
    title: 'Auth',
    description:
        'Sessions and the @user / @auth surface: a dev login mints a signed session cookie, the guarded /session/me returns the verified user, and getUser() reads the readable companion.',
};

/** Encode a bare string the way the server reads it (`DataReader.readString`). */
function encodeString(s: string): Uint8Array {
    return new DataWriter().writeString(s).toBytes();
}

/** The server-verified user from `GET /session/me` (binary: string, bool, u64). */
interface VerifiedUser {
    username: string;
    admin: boolean;
    score: string;
}

export default function Auth(): React.JSX.Element {
    const [username, setUsername] = useState('ada');
    const [verified, setVerified] = useState<VerifiedUser | null | 'none'>(null);
    const [busy, setBusy] = useState(false);
    const [log, setLog] = useState<string>('');

    // Hydration-safe: null on the server and first paint, the live companion
    // cookie after mount; `refreshCompanion()` re-reads after a login/logout.
    const [companion, refreshCompanion] = useBrowserValue(readCompanion, null);

    const devLogin = useCallback(async () => {
        setBusy(true);
        try {
            const res = await fetch('/session/dev-login', { method: 'POST', credentials: 'same-origin', body: encodeString(username) as BodyInit });
            setLog(`POST /session/dev-login -> ${res.status} ${(await res.text()).trim()}`);
            refreshCompanion();
            setVerified(null);
        } finally {
            setBusy(false);
        }
    }, [username, refreshCompanion]);

    const checkSession = useCallback(async () => {
        setBusy(true);
        try {
            const res = await fetch('/session/me', { credentials: 'same-origin' });
            if (res.status === 401) {
                setVerified('none');
                setLog('GET /session/me -> 401 (no valid session)');
                return;
            }

            const r = new DataReader(new Uint8Array(await res.arrayBuffer()));
            setVerified({ username: r.readString(), admin: r.readBool(), score: r.readU64().toString() });
            setLog('GET /session/me -> 200 (server-verified session)');
        } finally {
            setBusy(false);
        }
    }, []);

    const logout = useCallback(async () => {
        setBusy(true);
        try {
            const res = await fetch('/session/logout', { method: 'POST', credentials: 'same-origin' });
            setLog(`POST /session/logout -> ${res.status} ${(await res.text()).trim()}`);
            refreshCompanion();
            setVerified(null);
        } finally {
            setBusy(false);
        }
    }, [refreshCompanion]);

    return (
        <main style={{ maxWidth: 640, margin: '0 auto', padding: '2rem 1rem', lineHeight: 1.5 }}>
            <h1>Auth and sessions</h1>
            <p>
                A dev login mints an HMAC-signed <code>__Host-toil_sess</code> session cookie plus a
                readable <code>__Secure-toil_user</code> companion. The guarded <code>/session/me</code>{' '}
                route ( <code>@auth</code> ) re-verifies the signed session; <code>getUser()</code> reads
                only the companion (display-only, untrusted). Needs the server running.
            </p>

            <section style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <label>
                    user{' '}
                    <input
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        style={{ padding: '0.3rem 0.5rem' }}
                    />
                </label>
                <button onClick={devLogin} disabled={busy || username.length === 0}>
                    Dev login
                </button>
                <button onClick={checkSession} disabled={busy}>
                    Check /session/me
                </button>
                <button onClick={logout} disabled={busy}>
                    Logout
                </button>
            </section>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1.5rem' }}>
                <div style={{ border: '1px solid #2563ff55', borderRadius: 8, padding: '0.75rem 1rem' }}>
                    <h3 style={{ marginTop: 0 }}>getUser(), client</h3>
                    <p style={{ fontSize: '0.85em', opacity: 0.7, marginTop: 0 }}>
                        reads the readable companion cookie, untrusted, instant
                    </p>
                    {companion ? (
                        <pre>
                            {JSON.stringify(
                                { username: companion.username, admin: companion.admin, score: String(companion.score) },
                                null,
                                2,
                            )}
                        </pre>
                    ) : (
                        <p>no companion cookie</p>
                    )}
                </div>

                <div style={{ border: '1px solid #7c3aed55', borderRadius: 8, padding: '0.75rem 1rem' }}>
                    <h3 style={{ marginTop: 0 }}>/session/me, server</h3>
                    <p style={{ fontSize: '0.85em', opacity: 0.7, marginTop: 0 }}>
                        the server re-verifies the signed session, trusted
                    </p>
                    {verified === null ? (
                        <p>not checked yet</p>
                    ) : verified === 'none' ? (
                        <p>401, no valid session</p>
                    ) : (
                        <pre>{JSON.stringify(verified, null, 2)}</pre>
                    )}
                </div>
            </div>

            {log ? (
                <pre style={{ marginTop: '1rem', background: '#0e152099', padding: '0.5rem 0.75rem', borderRadius: 6 }}>
                    {log}
                </pre>
            ) : null}

            <p style={{ marginTop: '1.5rem', fontSize: '0.85em', opacity: 0.7 }}>
                The full post-quantum register/login (ML-DSA-44, password-derived) needs an account
                store and is stubbed in <code>server/routes/Auth.ts</code>. See <code>docs/auth.md</code>.
            </p>
        </main>
    );
}

import { useState } from 'react';
import { Auth, GoogleSignIn, TwoFactorRequiredError } from 'toiljs/client';

export const metadata: Toil.Metadata = { title: 'Google sign-in and Authenticator' };

/** Set AUTH_GOOGLE_CLIENT_ID and auth secrets as described in docs/auth/google-and-authenticator.md. */
export default function GoogleLogin(): React.JSX.Element {
    const [message, setMessage] = useState('Sign in to manage your authenticator.');
    const [challenge, setChallenge] = useState<string | null>(null);
    const [signedIn, setSignedIn] = useState(false);
    const [secret, setSecret] = useState<string | null>(null);
    const [code, setCode] = useState('');
    const [setup, setSetup] = useState(false);
    const [retry, setRetry] = useState(0);
    const [busy, setBusy] = useState(false);
    const handleError = (error: unknown): void => {
        if (error instanceof TwoFactorRequiredError) {
            setChallenge(error.twoFaId);
            setMessage('Enter the six-digit code from your authenticator or email.');
        } else setMessage('Sign-in failed. Check the application configuration or retry.');
    };
    const success = (): void => {
        setSignedIn(true);
        setChallenge(null);
        setMessage('Signed in.');
    };
    const verify = async (): Promise<void> => {
        setBusy(true);
        try {
            if (challenge) {
                await Auth.verifyTwoFactor(challenge, code);
                success();
            } else if (setup) {
                await Auth.confirmTwoFactorSetup(code);
                setSecret(null);
                setSetup(false);
                setSignedIn(false);
                setRetry((n) => n + 1);
                setMessage('Authenticator setting saved. Sign in again using a fresh code.');
            }
            setCode('');
        } catch {
            setMessage('Code invalid, expired, or already used. Try a fresh code.');
        } finally {
            setBusy(false);
        }
    };
    const enroll = async (): Promise<void> => {
        setBusy(true);
        try {
            const result = await Auth.setupAuthenticator('Toil example', 'Your account');
            setSecret(result.secret);
            setSetup(true);
            setMessage('Add this setup key to Google Authenticator, then enter its code.');
        } catch {
            setMessage('Unable to enroll. Disable the existing factor with its code first.');
        } finally {
            setBusy(false);
        }
    };
    const disable = async (): Promise<void> => {
        setBusy(true);
        try {
            await Auth.setupTwoFactor(Auth.TwoFactorMethod.None);
            setSetup(true);
            setSecret(null);
            setMessage('Enter a fresh code from the current factor to disable it.');
        } catch {
            setMessage('Unable to start factor removal. Sign in and retry.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <main>
            <h1>Google sign-in and Authenticator</h1>
            <p role="status">{message}</p>
            {!signedIn && !challenge && (
                <>
                    <GoogleSignIn key={retry} onSuccess={success} onError={handleError} />
                    <button type="button" onClick={() => setRetry((n) => n + 1)}>
                        Retry sign-in
                    </button>
                </>
            )}
            {signedIn && !setup && (
                <>
                    <button type="button" disabled={busy} onClick={() => void enroll()}>
                        Set up Google Authenticator
                    </button>
                    <button type="button" disabled={busy} onClick={() => void disable()}>
                        Disable two-factor authentication
                    </button>
                </>
            )}
            {secret && (
                <p>
                    Setup key: <code>{secret}</code>
                </p>
            )}
            {(challenge || setup) && (
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void verify();
                    }}>
                    <label>
                        Verification code{' '}
                        <input
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="[0-9]{6}"
                            maxLength={6}
                            required
                        />
                    </label>
                    <button type="submit" disabled={busy}>
                        Verify code
                    </button>
                </form>
            )}
        </main>
    );
}

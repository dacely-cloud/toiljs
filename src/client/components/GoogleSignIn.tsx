import { useCallback, useEffect, useRef, useState } from 'react';
import { googleLoginStart, loginWithGoogle, type AuthOptions } from '../auth.js';
import { Script } from './Script.js';

interface GoogleId {
    initialize(options: {
        client_id: string;
        nonce: string;
        use_fedcm_for_button: boolean;
        callback(response: { credential: string }): void;
    }): void;
    renderButton(parent: HTMLElement, options: { type: string; theme: string; size: string }): void;
}
export interface GoogleSignInProps {
    onSuccess: (session: Uint8Array) => void;
    /** Includes TwoFactorRequiredError; complete with Auth.verifyTwoFactor. */
    onError: (error: unknown) => void;
    options?: AuthOptions;
    className?: string;
}

/** Official Google button. Render one sign-in widget per page (GIS has one global configuration). */
export function GoogleSignIn({
    onSuccess,
    onError,
    options,
    className,
}: GoogleSignInProps): React.JSX.Element {
    const element = useRef<HTMLDivElement>(null);
    const callbacks = useRef({ onSuccess, onError });
    callbacks.current = { onSuccess, onError };
    const [loaded, setLoaded] = useState(false);
    const ready = useCallback(() => setLoaded(true), []);
    const baseUrl = options?.baseUrl;
    const headers = options?.headers;
    const onRequestFailed = options?.onRequestFailed;
    useEffect(() => {
        if (!loaded || !element.current) return;
        let cancelled = false;
        const parent = element.current;
        void googleLoginStart({ baseUrl, headers, onRequestFailed })
            .then(({ clientId, nonce }) => {
                if (cancelled) return;
                const id = (window as unknown as { google: { accounts: { id: GoogleId } } }).google
                    .accounts.id;
                id.initialize({
                    client_id: clientId,
                    nonce,
                    use_fedcm_for_button: true,
                    callback({ credential }) {
                        if (cancelled) return;
                        void loginWithGoogle(credential, {
                            baseUrl,
                            headers,
                            onRequestFailed,
                        }).then(
                            (session) => {
                                if (!cancelled) callbacks.current.onSuccess(session);
                            },
                            (error: unknown) => {
                                if (!cancelled) callbacks.current.onError(error);
                            },
                        );
                    },
                });
                id.renderButton(parent, { type: 'standard', theme: 'outline', size: 'large' });
            })
            .catch((error: unknown) => {
                if (!cancelled) callbacks.current.onError(error);
            });
        return () => {
            cancelled = true;
            parent.replaceChildren();
        };
    }, [loaded, baseUrl, headers, onRequestFailed]);
    return (
        <>
            <Script
                src="https://accounts.google.com/gsi/client"
                onReady={ready}
                onError={(error) => callbacks.current.onError(error)}
            />
            <div
                ref={element}
                className={className}
            />
        </>
    );
}

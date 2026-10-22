// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GoogleSignIn } from '../src/client/components/GoogleSignIn.js';
import { TwoFactorRequiredError } from '../src/client/auth.js';
import { DataReader, DataWriter } from '../src/io/codec.js';
vi.mock('../src/client/components/Script.js', async () => {
    const { useEffect } = await import('react');
    return {
        Script: ({ onReady }: { onReady(): void }) => {
            useEffect(() => onReady(), [onReady]);
            return null;
        },
    };
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
it('configures the official button with the server nonce and forwards a second-factor challenge', async () => {
    let callback!: (response: { credential: string }) => void;
    const initialize = vi.fn((options: { callback: typeof callback }) => {
        callback = options.callback;
    });
    const renderButton = vi.fn();
    vi.stubGlobal('google', { accounts: { id: { initialize, renderButton } } });
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
        const bytes =
            request.mock.calls.length === 1
                ? new DataWriter().writeString('client-id').writeString('nonce').toBytes()
                : new DataWriter()
                      .writeU8(3)
                      .writeBytes(new Uint8Array([1, 2, 3]))
                      .toBytes();
        if (request.mock.calls.length === 2)
            expect(new DataReader(new Uint8Array(init?.body as ArrayBuffer)).readString()).toBe(
                'credential',
            );
        return new Response(bytes as BodyInit);
    });
    vi.stubGlobal('fetch', request);
    const onError = vi.fn(),
        onSuccess = vi.fn();
    render(
        <GoogleSignIn
            onSuccess={onSuccess}
            onError={onError}
            options={{ baseUrl: '/auth' }}
        />,
    );
    await waitFor(() => expect(renderButton).toHaveBeenCalledOnce());
    expect(initialize).toHaveBeenCalledWith(
        expect.objectContaining({
            client_id: 'client-id',
            nonce: 'nonce',
            use_fedcm_for_button: true,
        }),
    );
    await act(async () => callback({ credential: 'credential' }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onError.mock.calls[0][0]).toBeInstanceOf(TwoFactorRequiredError);
    expect(onError.mock.calls[0][0].twoFaId).toBe('010203');
    expect(onSuccess).not.toHaveBeenCalled();
});

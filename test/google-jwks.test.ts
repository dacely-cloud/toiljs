import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const key = {
    ...generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }),
    alg: 'RS256',
    kid: 'key',
    use: 'sig',
};
beforeEach(() => vi.resetModules());
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
it('shares a cold fetch across concurrent requests and reuses the cache', async () => {
    const { prepareGoogleKeys } = await import('../src/devserver/runtime/google.js');
    let finish!: (response: Response) => void;
    const request = vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
            finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', request);
    let completions = 0;
    const first = prepareGoogleKeys().then(() => {
        completions++;
    });
    const second = prepareGoogleKeys().then(() => {
        completions++;
    });
    await Promise.resolve();
    expect(completions).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
    finish(
        new Response(JSON.stringify({ keys: [key] }), {
            headers: { 'cache-control': 'max-age=3600' },
        }),
    );
    await Promise.all([first, second]);
    expect(completions).toBe(2);
    await prepareGoogleKeys();
    expect(request).toHaveBeenCalledTimes(1);
});
it('caps failed refresh retries and fails closed without keys', async () => {
    const { prepareGoogleKeys, verifyGoogleToken } =
        await import('../src/devserver/runtime/google.js');
    const request = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    vi.stubGlobal('fetch', request);
    await expect(prepareGoogleKeys()).rejects.toThrow();
    await prepareGoogleKeys();
    expect(request).toHaveBeenCalledTimes(1);
    expect(verifyGoogleToken('a.b.c', 'client', 'nonce')).toBeNull();
});
it('rejects oversized and malformed JWKS responses', async () => {
    const { prepareGoogleKeys } = await import('../src/devserver/runtime/google.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(65537))));
    await expect(prepareGoogleKeys()).rejects.toThrow('too large');
});

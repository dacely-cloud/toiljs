import { afterEach, describe, expect, it, vi } from 'vitest';
import { login, setupTwoFactor, twoFactorStatus } from '../src/client/auth.js';

afterEach(() => vi.unstubAllGlobals());

describe('auth deployment options', () => {
    it('rejects a missing or malformed pinned key before making a login request', async () => {
        const request = vi.fn();
        vi.stubGlobal('fetch', request);
        await expect(login('example', 'password')).rejects.toThrow('deployment ML-KEM public key');
        await expect(login('example', 'password', { serverKemPublicKey: new Uint8Array(12) })).rejects.toThrow('deployment ML-KEM public key');
        expect(request).not.toHaveBeenCalled();
    });

    it('forwards account guards and reports HTTP failures for factor mutations', async () => {
        const request = vi.fn().mockResolvedValue(new Response('', { status: 412 }));
        vi.stubGlobal('fetch', request);
        const onRequestFailed = vi.fn();
        await expect(setupTwoFactor(1, { headers: { 'x-account': 'alice' }, onRequestFailed })).rejects.toThrow('HTTP 412');
        expect(request).toHaveBeenCalledWith('/auth/2fa/setup', expect.objectContaining({ headers: { 'content-type': 'application/octet-stream', 'x-account': 'alice' } }));
        expect(onRequestFailed).toHaveBeenCalledWith(412);
    });

    it('forwards account guards and reports HTTP failures for factor reads', async () => {
        const request = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
        vi.stubGlobal('fetch', request);
        const onRequestFailed = vi.fn();
        await expect(twoFactorStatus({ headers: { 'x-account': 'alice' }, onRequestFailed })).rejects.toThrow('HTTP 401');
        expect(request).toHaveBeenCalledWith('/auth/2fa/status', expect.objectContaining({ headers: { 'x-account': 'alice' } }));
        expect(onRequestFailed).toHaveBeenCalledWith(401);
    });
});

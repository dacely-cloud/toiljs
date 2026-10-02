import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { ml_kem768 } from '@dacely/noble-post-quantum/ml-kem.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runGenerate } from '../src/cli/generate';

const roots: string[] = [];
function project(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-auth-'));
    roots.push(root);
    return root;
}
function contents(root: string, file: string): string {
    return fs.readFileSync(path.join(root, file), 'utf8');
}
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('generate auth', () => {
    it('writes a working key pair, protects secrets, and never prints values', () => {
        const root = project();
        const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        runGenerate('auth', { root });
        const secrets = parseEnv(contents(root, '.env.secrets'));
        const env = parseEnv(contents(root, '.env'));
        expect(secrets.AUTH_SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
        expect(secrets.AUTH_OPRF_SEED).toMatch(/^[0-9a-f]{64}$/);
        expect(secrets.AUTH_SESSION_SECRET).not.toBe(secrets.AUTH_OPRF_SEED);
        expect(env.VITE_AUTH_KEM_PUBLIC_KEY).toMatch(/^[0-9a-f]{2368}$/);
        const pk = Buffer.from(env.VITE_AUTH_KEM_PUBLIC_KEY, 'hex');
        const sk = Buffer.from(secrets.AUTH_KEM_SK, 'hex');
        const { cipherText, sharedSecret } = ml_kem768.encapsulate(pk);
        expect(ml_kem768.decapsulate(cipherText, sk)).toEqual(sharedSecret);
        expect(fs.statSync(path.join(root, '.env.secrets')).mode & 0o777).toBe(0o600);
        expect(contents(root, '.gitignore')).toContain('/.env.secrets\n');
        for (const value of Object.values(secrets))
            expect(output.mock.calls.flat().join('')).not.toContain(value);
        expect(contents(root, '.env')).not.toContain('AUTH_KEM_SK');
    });

    it('preserves unrelated settings and never rotates credentials on rerun', () => {
        const root = project();
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        fs.writeFileSync(
            path.join(root, '.env'),
            '# settings\nPUBLIC_BASE_URL=https://example.com',
        );
        fs.writeFileSync(path.join(root, '.env.secrets'), 'TOIL_EMAIL_API_KEY=re_existing\n');
        runGenerate('auth', { root });
        const before = ['.env', '.env.secrets', '.gitignore'].map((file) => contents(root, file));
        runGenerate('auth', { root });
        expect(['.env', '.env.secrets', '.gitignore'].map((file) => contents(root, file))).toEqual(
            before,
        );
        expect(before[0]).toContain('PUBLIC_BASE_URL=https://example.com\n');
        expect(before[1]).toContain('TOIL_EMAIL_API_KEY=re_existing\n');
    });

    it('restores a missing public key from existing secrets without changing them', () => {
        const root = project();
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        runGenerate('auth', { root });
        const secrets = contents(root, '.env.secrets');
        const env = contents(root, '.env');
        fs.unlinkSync(path.join(root, '.env'));
        runGenerate('auth', { root });
        expect(contents(root, '.env')).toBe(env);
        expect(contents(root, '.env.secrets')).toBe(secrets);
    });

    it.each(['AUTH_KEM_SK=bad\n', 'AUTH_SESSION_SECRET=""\n'])(
        'refuses invalid existing credentials without writes: %s',
        (text) => {
            const root = project();
            fs.writeFileSync(path.join(root, '.env.secrets'), text);
            expect(() => runGenerate('auth', { root })).toThrow();
            expect(contents(root, '.env.secrets')).toBe(text);
            expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
            expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
        },
    );

    it('refuses a mismatched public key without rotating the secret', () => {
        const root = project();
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        runGenerate('auth', { root });
        const secrets = contents(root, '.env.secrets');
        fs.writeFileSync(path.join(root, '.env'), 'VITE_AUTH_KEM_PUBLIC_KEY=wrong\n');
        expect(() => runGenerate('auth', { root })).toThrow('does not match');
        expect(contents(root, '.env.secrets')).toBe(secrets);
        expect(contents(root, '.env')).toBe('VITE_AUTH_KEM_PUBLIC_KEY=wrong\n');
    });

    it('does not replace a public key whose private key is missing', () => {
        const root = project();
        fs.writeFileSync(path.join(root, '.env'), 'VITE_AUTH_KEM_PUBLIC_KEY=existing\n');
        expect(() => runGenerate('auth', { root })).toThrow('Restore its matching');
        expect(fs.existsSync(path.join(root, '.env.secrets'))).toBe(false);
    });

    it('rejects symlinks and private keys in the public env file', () => {
        const root = project();
        fs.writeFileSync(path.join(root, 'other'), 'do not overwrite');
        fs.symlinkSync(path.join(root, 'other'), path.join(root, '.env.secrets'));
        expect(() => runGenerate('auth', { root })).toThrow('regular file');
        expect(contents(root, 'other')).toBe('do not overwrite');
        fs.unlinkSync(path.join(root, '.env.secrets'));
        fs.writeFileSync(path.join(root, '.env'), 'AUTH_SESSION_SECRET=private\n');
        expect(() => runGenerate('auth', { root })).toThrow('Move AUTH_SESSION_SECRET');
    });

    it('rejects unsupported generation targets', () => {
        expect(() => runGenerate('unknown', { root: project() })).toThrow('Usage:');
    });
});

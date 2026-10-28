import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../../src/compiler/config.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([
    false,
    [],
    'false',
    { google: 'false' },
    { twoFactorSetup: 0 },
    { deleteAccount: 'false' },
    { typo: false },
])(
    'rejects malformed auth route policy instead of silently enabling routes (%j)',
    async (authRoutes) => {
        const dir = mkdtempSync(join(tmpdir(), 'toil-auth-config-'));
        dirs.push(dir);
        writeFileSync(
            join(dir, 'toil.config.mjs'),
            `export default ${JSON.stringify({ server: { authRoutes } })};`,
        );
        await expect(loadConfig({ root: dir })).rejects.toThrow('server.authRoutes');
    },
);

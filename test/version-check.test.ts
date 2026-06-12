import { describe, expect, it } from 'vitest';

import {
    CHECK_TTL_MS,
    compareSemver,
    findOutdated,
    installCommand,
    isCacheFresh,
    isOutdated,
    parseCheckCache,
} from '../src/cli/version-check';

describe('compareSemver', () => {
    it('orders plain versions', () => {
        expect(compareSemver('0.0.31', '0.0.32')).toBeLessThan(0);
        expect(compareSemver('0.0.32', '0.0.31')).toBeGreaterThan(0);
        expect(compareSemver('0.0.31', '0.0.31')).toBe(0);
        expect(compareSemver('0.9.9', '0.10.0')).toBeLessThan(0);
        expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    });

    it('treats a prerelease as older than its release', () => {
        expect(compareSemver('0.1.0-beta.1', '0.1.0')).toBeLessThan(0);
        expect(compareSemver('0.1.0', '0.1.0-beta.1')).toBeGreaterThan(0);
        expect(compareSemver('0.1.0-alpha', '0.1.0-beta')).toBeLessThan(0);
    });

    it('tolerates a leading v and garbage input', () => {
        expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
        expect(compareSemver('garbage', '0.0.0')).toBe(0);
    });
});

describe('isOutdated', () => {
    it('is true only when installed is behind latest', () => {
        expect(isOutdated('0.0.31', '0.0.32')).toBe(true);
        expect(isOutdated('0.0.32', '0.0.32')).toBe(false);
        // A local build ahead of the registry must not warn.
        expect(isOutdated('0.0.33', '0.0.32')).toBe(false);
    });
});

describe('parseCheckCache', () => {
    it('parses a valid cache entry', () => {
        expect(parseCheckCache('{"latest":"0.0.32","checkedAt":1000}')).toEqual({
            latest: '0.0.32',
            checkedAt: 1000,
        });
    });

    it('keeps a cached failure (latest null) so offline machines back off', () => {
        expect(parseCheckCache('{"latest":null,"checkedAt":1000}')).toEqual({
            latest: null,
            checkedAt: 1000,
        });
    });

    it('rejects malformed contents', () => {
        expect(parseCheckCache('not json')).toBeNull();
        expect(parseCheckCache('[]')).toBeNull();
        expect(parseCheckCache('{"latest":"0.0.32"}')).toBeNull();
        expect(parseCheckCache('{"latest":42,"checkedAt":"soon"}')).toBeNull();
    });
});

describe('isCacheFresh', () => {
    const cache = { latest: '0.0.32', checkedAt: 10_000 };

    it('is fresh within the TTL and stale after it', () => {
        expect(isCacheFresh(cache, 10_000 + CHECK_TTL_MS - 1)).toBe(true);
        expect(isCacheFresh(cache, 10_000 + CHECK_TTL_MS)).toBe(false);
    });

    it('is stale when the clock went backwards past checkedAt', () => {
        expect(isCacheFresh(cache, 9_999)).toBe(false);
    });
});

describe('installCommand', () => {
    it('targets the project with the detected package manager', () => {
        expect(installCommand('npm', 'project')).toBe('npm install toiljs@latest');
        expect(installCommand('pnpm', 'project')).toBe('pnpm add toiljs@latest');
        expect(installCommand('yarn', 'project')).toBe('yarn add toiljs@latest');
        expect(installCommand('bun', 'project')).toBe('bun add toiljs@latest');
    });

    it('targets the global install', () => {
        expect(installCommand('npm', 'global')).toBe('npm install -g toiljs@latest');
        expect(installCommand('pnpm', 'global')).toBe('pnpm add -g toiljs@latest');
    });
});

describe('findOutdated', () => {
    it('flags an outdated project install with the project command', () => {
        const rows = findOutdated('0.0.32', '0.0.31', '0.0.31', true, 'pnpm');
        expect(rows).toEqual([
            { scope: 'project', installed: '0.0.31', command: 'pnpm add toiljs@latest' },
        ]);
    });

    it('flags an outdated global CLI even when the project is current', () => {
        const rows = findOutdated('0.0.32', '0.0.32', '0.0.30', false, 'npm');
        expect(rows).toEqual([
            { scope: 'global', installed: '0.0.30', command: 'npm install -g toiljs@latest' },
        ]);
    });

    it('flags both when a stale global CLI runs inside a stale project', () => {
        const rows = findOutdated('0.0.32', '0.0.31', '0.0.30', false, 'npm');
        expect(rows.map((r) => r.scope)).toEqual(['project', 'global']);
    });

    it('does not double-report when the running CLI is the project install', () => {
        const rows = findOutdated('0.0.32', '0.0.31', '0.0.31', true, 'npm');
        expect(rows).toHaveLength(1);
        expect(rows[0].scope).toBe('project');
    });

    it('reports nothing when everything is current or ahead', () => {
        expect(findOutdated('0.0.32', '0.0.32', '0.0.32', true, 'npm')).toEqual([]);
        expect(findOutdated('0.0.32', null, '0.0.33', false, 'npm')).toEqual([]);
    });

    it('handles a missing project install (npx outside a project)', () => {
        const rows = findOutdated('0.0.32', null, '0.0.31', false, 'npm');
        expect(rows).toEqual([
            { scope: 'global', installed: '0.0.31', command: 'npm install -g toiljs@latest' },
        ]);
    });
});

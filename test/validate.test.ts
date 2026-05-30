import { describe, expect, it } from 'vitest';

import { isPackageManager, isValidName, resolveProjectDir } from '../src/cli/validate';

describe('isValidName', () => {
    it('accepts simple and nested names', () => {
        expect(isValidName('my-app')).toBe(true);
        expect(isValidName('apps/web')).toBe(true);
        expect(isValidName('@scope/app')).toBe(true);
    });

    it('rejects empty and illegal characters', () => {
        expect(typeof isValidName('')).toBe('string');
        expect(typeof isValidName('  ')).toBe('string');
        expect(typeof isValidName('bad name!')).toBe('string');
    });
});

describe('resolveProjectDir', () => {
    it('resolves names inside cwd', () => {
        expect(resolveProjectDir('/work', 'app')).toBe('/work/app');
        expect(resolveProjectDir('/work', 'a/b')).toBe('/work/a/b');
        expect(resolveProjectDir('/work', '.')).toBe('/work');
    });

    it('refuses to escape cwd (traversal / absolute)', () => {
        expect(resolveProjectDir('/work', '../evil')).toBeNull();
        expect(resolveProjectDir('/work', '../../etc')).toBeNull();
        expect(resolveProjectDir('/work', '/etc/passwd')).toBeNull();
    });
});

describe('isPackageManager', () => {
    it('allowlists known package managers only', () => {
        expect(isPackageManager('npm')).toBe(true);
        expect(isPackageManager('pnpm')).toBe(true);
        expect(isPackageManager('yarn')).toBe(true);
        expect(isPackageManager('bun')).toBe(true);
        expect(isPackageManager('npm && calc')).toBe(false);
        expect(isPackageManager('rm -rf /')).toBe(false);
    });
});

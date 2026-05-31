import { describe, expect, it } from 'vitest';

import { matchActive } from '../src/client/NavLink';

describe('matchActive', () => {
    it('matches exact paths', () => {
        expect(matchActive('/about', '/about', false)).toBe(true);
        expect(matchActive('/about', '/about/', false)).toBe(true);
        expect(matchActive('/about', '/contact', false)).toBe(false);
    });

    it('matches sub-paths when not exact (end=false)', () => {
        expect(matchActive('/blog', '/blog/42', false)).toBe(true);
        expect(matchActive('/blog', '/blog', false)).toBe(true);
        expect(matchActive('/blog', '/blogger', false)).toBe(false);
    });

    it('honors end for exact-only matching', () => {
        expect(matchActive('/blog', '/blog/42', true)).toBe(false);
        expect(matchActive('/blog', '/blog', true)).toBe(true);
    });

    it('treats "/" as active everywhere unless end', () => {
        expect(matchActive('/', '/anything/deep', false)).toBe(true);
        expect(matchActive('/', '/anything', true)).toBe(false);
        expect(matchActive('/', '/', true)).toBe(true);
    });
});

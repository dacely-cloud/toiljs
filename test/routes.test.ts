import { describe, expect, it } from 'vitest';

import { matchRoute } from '../src/client/match';
import { filePathToRoute } from '../src/compiler/routes';

describe('filePathToRoute', () => {
    it('maps index, static, nested, and dynamic files to patterns', () => {
        expect(filePathToRoute('index.tsx')).toBe('/');
        expect(filePathToRoute('about.tsx')).toBe('/about');
        expect(filePathToRoute('blog/index.tsx')).toBe('/blog');
        expect(filePathToRoute('blog/[id].tsx')).toBe('/blog/:id');
        expect(filePathToRoute('docs/guide/intro.jsx')).toBe('/docs/guide/intro');
        expect(filePathToRoute('docs/[...slug].tsx')).toBe('/docs/*slug');
    });

    it('maps optional catch-all and strips route groups', () => {
        expect(filePathToRoute('docs/[[...slug]].tsx')).toBe('/docs/**slug');
        expect(filePathToRoute('[[...slug]].tsx')).toBe('/**slug');
        expect(filePathToRoute('(marketing)/about.tsx')).toBe('/about');
        expect(filePathToRoute('(shop)/index.tsx')).toBe('/');
        expect(filePathToRoute('(a)/(b)/deep.tsx')).toBe('/deep');
    });
});

describe('matchRoute', () => {
    it('matches static routes', () => {
        expect(matchRoute('/', '/')).toEqual({});
        expect(matchRoute('/about', '/about')).toEqual({});
    });

    it('rejects non-matches', () => {
        expect(matchRoute('/about', '/x')).toBeNull();
        expect(matchRoute('/blog/:id', '/blog')).toBeNull();
        expect(matchRoute('/', '/about')).toBeNull();
    });

    it('extracts dynamic params', () => {
        expect(matchRoute('/blog/:id', '/blog/42')).toEqual({ id: '42' });
        expect(matchRoute('/u/:user/p/:post', '/u/ann/p/7')).toEqual({ user: 'ann', post: '7' });
        expect(matchRoute('/blog/:id', '/blog/a%20b')).toEqual({ id: 'a b' });
    });

    it('captures the tail with catch-all routes', () => {
        expect(matchRoute('/docs/*slug', '/docs/a/b/c')).toEqual({ slug: 'a/b/c' });
        expect(matchRoute('/docs/*slug', '/docs/intro')).toEqual({ slug: 'intro' });
        expect(matchRoute('/files/*path', '/files/a%20b/c')).toEqual({ path: 'a b/c' });
        // catch-all needs at least one trailing segment
        expect(matchRoute('/docs/*slug', '/docs')).toBeNull();
    });

    it('matches optional catch-all with zero or more segments', () => {
        expect(matchRoute('/docs/**slug', '/docs')).toEqual({ slug: '' });
        expect(matchRoute('/docs/**slug', '/docs/a/b')).toEqual({ slug: 'a/b' });
        expect(matchRoute('/**slug', '/')).toEqual({ slug: '' });
        expect(matchRoute('/**slug', '/x/y')).toEqual({ slug: 'x/y' });
    });
});

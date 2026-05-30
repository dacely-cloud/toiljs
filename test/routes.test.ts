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
});

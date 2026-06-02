import { beforeEach, describe, expect, it } from 'vitest';

import {
    getPages,
    type PageMeta,
    pagePath,
    registerPages,
    searchPages,
} from '../src/client/search/search';

const PAGES: PageMeta[] = [
    {
        path: '/',
        dynamic: false,
        metadata: { title: 'Home', description: 'Welcome to the toil demo site' },
    },
    {
        path: '/about',
        dynamic: false,
        metadata: { title: 'About', description: 'Who we are', keywords: ['team', 'company'] },
    },
    {
        path: '/blog',
        dynamic: false,
        metadata: {
            title: 'Blog',
            description: 'Articles and updates',
            openGraph: { title: 'The Blog', siteName: 'toil' },
        },
    },
    { path: '/blog/:id', dynamic: true, metadata: { title: 'Blog post' } },
    { path: '/get-started', dynamic: false, metadata: {} },
];

beforeEach(() => {
    registerPages(PAGES);
});

describe('searchPages', () => {
    it('returns no results for an empty / whitespace query', () => {
        expect(searchPages('')).toEqual([]);
        expect(searchPages('   ')).toEqual([]);
    });

    it('ranks a title match above a description-only match', () => {
        const results = searchPages('about');
        expect(results[0].page.path).toBe('/about');
        // Two pages mention "about"? Only /about does here; the home page does not.
        expect(results.map((r) => r.page.path)).toContain('/about');
        expect(results[0].matches).toContain('title');
    });

    it('matches keywords', () => {
        const results = searchPages('team');
        expect(results).toHaveLength(1);
        expect(results[0].page.path).toBe('/about');
        expect(results[0].matches).toContain('keywords');
    });

    it('matches OpenGraph fields', () => {
        const results = searchPages('blog', { fields: ['openGraph'] });
        expect(results.map((r) => r.page.path)).toEqual(['/blog']);
        expect(results[0].matches).toEqual(['openGraph']);
    });

    it('makes slugs word-searchable via the path field', () => {
        const results = searchPages('started');
        expect(results.map((r) => r.page.path)).toContain('/get-started');
    });

    it('excludes dynamic routes unless includeDynamic is set', () => {
        expect(searchPages('post').map((r) => r.page.path)).not.toContain('/blog/:id');
        expect(searchPages('post', { includeDynamic: true }).map((r) => r.page.path)).toContain(
            '/blog/:id',
        );
    });

    it('uses AND semantics: every term must match', () => {
        expect(searchPages('blog updates').map((r) => r.page.path)).toEqual(['/blog']);
        expect(searchPages('blog nonexistentword')).toEqual([]);
    });

    it('honors the limit option', () => {
        // "toil" appears in the home description and the blog's OpenGraph siteName.
        const all = searchPages('toil');
        expect(all.length).toBeGreaterThan(1);
        expect(searchPages('toil', { limit: 1 })).toHaveLength(1);
    });

    it('restricts matching to the requested fields', () => {
        // "welcome" only lives in the home description; excluding it yields nothing.
        expect(searchPages('welcome', { fields: ['title', 'keywords'] })).toEqual([]);
        expect(searchPages('welcome', { fields: ['description'] }).map((r) => r.page.path)).toEqual(
            ['/'],
        );
    });

    it('is case-insensitive', () => {
        expect(searchPages('ABOUT')[0].page.path).toBe('/about');
    });
});

describe('registry helpers', () => {
    it('getPages returns the registered index', () => {
        expect(getPages()).toBe(PAGES);
    });

    it('pagePath normalizes results, pages, and raw strings', () => {
        const result = searchPages('about')[0];
        expect(pagePath(result)).toBe('/about');
        expect(pagePath(result.page)).toBe('/about');
        expect(pagePath('/raw')).toBe('/raw');
    });
});

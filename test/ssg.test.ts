import { describe, expect, it } from 'vitest';

import { sitemapXml, type SeoConfig } from '../src/compiler/seo';
import { fillPattern } from '../src/compiler/ssg';
import { type ScannedRoute } from '../src/compiler/routes';

describe('fillPattern', () => {
    it('substitutes :param and *catch-all segments', () => {
        expect(fillPattern('/:a/:b/:c', { a: 'x', b: 'y', c: 'z' })).toBe('/x/y/z');
        expect(fillPattern('/blog/:id', { id: '42' })).toBe('/blog/42');
        expect(fillPattern('/docs/*slug', { slug: ['a', 'b'] })).toBe('/docs/a/b');
        expect(fillPattern('/static', {})).toBe('/static');
    });
});

describe('sitemapXml with SSG paths', () => {
    const seo: SeoConfig = { url: 'https://x.dev' };
    const routes: ScannedRoute[] = [
        { file: 'a', pattern: '/' },
        { file: 'b', pattern: '/about' },
        { file: 'c', pattern: '/blog/:id' },
    ];

    it('lists static routes plus enumerated SSG URLs, deduped, never the bare pattern', () => {
        const xml = sitemapXml(seo, routes, ['/blog/1', '/blog/2', '/about']);
        expect(xml).toContain('https://x.dev/blog/1');
        expect(xml).toContain('https://x.dev/blog/2');
        expect(xml).toContain('https://x.dev/about');
        expect(xml).not.toContain('/blog/:id'); // dynamic pattern is never listed literally
        expect((xml.match(/<loc>[^<]*\/about<\/loc>/g) ?? []).length).toBe(1); // deduped
    });

    it('is empty without a base url', () => {
        expect(sitemapXml({}, routes, ['/blog/1'])).toBe('');
    });
});

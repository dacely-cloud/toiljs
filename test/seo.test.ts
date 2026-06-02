import { describe, expect, it } from 'vitest';

import type { ScannedRoute } from '../src/compiler/routes';
import {
    injectSeoHtml,
    llmsTxt,
    robotsTxt,
    routeSeo,
    seoHeadTags,
    sitemapXml,
} from '../src/compiler/seo';

const routes: ScannedRoute[] = [
    { file: 'a', pattern: '/' },
    { file: 'b', pattern: '/about' },
    { file: 'c', pattern: '/blog/:id' }, // dynamic, excluded from sitemap
    { file: 'd', pattern: '/photo/:id', slot: 'modal', intercept: true }, // slot/intercept, excluded
];

describe('seoHeadTags', () => {
    it('bakes description, OG, canonical, preconnect, and JSON-LD', () => {
        const html = seoHeadTags({
            url: 'https://x.test',
            title: 'Home',
            description: 'desc',
            openGraph: { type: 'website', image: 'https://x.test/og.png' },
            preconnect: ['https://cdn.test'],
            jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite' },
        });
        expect(html).toContain('<meta name="description" content="desc" />');
        expect(html).toContain('<meta property="og:title" content="Home" />');
        expect(html).toContain('<meta property="og:image" content="https://x.test/og.png" />');
        expect(html).toContain('<link rel="canonical" href="https://x.test" />');
        expect(html).toContain('<link rel="preconnect" href="https://cdn.test" />');
        expect(html).toContain('application/ld+json');
        expect(html).toContain('"@type":"WebSite"');
    });

    it('escapes attribute values', () => {
        expect(seoHeadTags({ description: 'a "b" <c>' })).toContain(
            'content="a &quot;b&quot; &lt;c&gt;"',
        );
    });

    it('renders a full Twitter card + OG image dimensions + fb:app_id', () => {
        const html = seoHeadTags({
            title: 'Home',
            description: 'd',
            openGraph: {
                image: 'https://x.test/og.png',
                imageAlt: 'alt',
                imageWidth: 1200,
                imageHeight: 630,
            },
            twitter: { site: '@x' },
            facebook: { appId: '123' },
        });
        expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
        expect(html).toContain('<meta name="twitter:site" content="@x" />');
        expect(html).toContain('<meta name="twitter:title" content="Home" />');
        expect(html).toContain('<meta name="twitter:image" content="https://x.test/og.png" />');
        expect(html).toContain('<meta property="og:image:width" content="1200" />');
        expect(html).toContain('<meta property="og:image:alt" content="alt" />');
        expect(html).toContain('<meta property="fb:app_id" content="123" />');
    });

    it('neutralizes </script> in JSON-LD (no script breakout)', () => {
        const html = seoHeadTags({ jsonLd: { x: '</script><img src=x onerror=alert(1)>' } });
        expect(html).not.toContain('</script><img');
        expect(html).toContain('\\u003c/script');
    });
});

describe('routeSeo', () => {
    it("overlays a route's metadata over the site defaults and points URLs at the route", () => {
        const site = { url: 'https://x.test', title: 'Site', description: 'site desc' };
        const out = routeSeo(site, { title: 'About', description: 'about desc' }, '/about');
        expect(out.title).toBe('About');
        expect(out.description).toBe('about desc');
        expect(out.url).toBe('https://x.test/about');
    });

    it('falls back to the site defaults when a route has no metadata', () => {
        const site = { url: 'https://x.test', title: 'Site' };
        expect(routeSeo(site, null, '/x')).toMatchObject({
            title: 'Site',
            url: 'https://x.test/x',
        });
    });
});

describe('injectSeoHtml', () => {
    it('replaces the title + description and inserts the rest before </head>', () => {
        const shell =
            '<!doctype html><html><head><title>old</title><meta name="description" content="" /></head><body></body></html>';
        const out = injectSeoHtml(shell, {
            title: 'New',
            description: 'fresh',
            url: 'https://x.test',
        });
        expect(out).toContain('<title>New</title>');
        expect(out).not.toContain('<title>old</title>');
        expect(out.match(/name="description"/g)).toHaveLength(1);
        expect(out).toContain('content="fresh"');
        expect(out).toContain('<link rel="canonical" href="https://x.test" />');
    });
});

describe('robotsTxt', () => {
    it('allows all + lists AI crawlers + links the sitemap by default', () => {
        const txt = robotsTxt({ url: 'https://x.test' });
        expect(txt).toContain('User-agent: *');
        expect(txt).toContain('Allow: /');
        expect(txt).toContain('User-agent: GPTBot');
        expect(txt).toContain('User-agent: ClaudeBot');
        expect(txt).toContain('Sitemap: https://x.test/sitemap.xml');
    });

    it('disallows AI crawlers when ai: "disallow"', () => {
        const txt = robotsTxt({ url: 'https://x.test', robots: { ai: 'disallow' } });
        expect(txt).toMatch(/User-agent: GPTBot\nDisallow: \//);
    });

    it('is empty when robots: false', () => {
        expect(robotsTxt({ robots: false })).toBe('');
    });
});

describe('sitemapXml', () => {
    it('lists only static routes, absolute', () => {
        const xml = sitemapXml({ url: 'https://x.test' }, routes);
        expect(xml).toContain('<loc>https://x.test</loc>');
        expect(xml).toContain('<loc>https://x.test/about</loc>');
        expect(xml).not.toContain(':id');
        expect(xml).not.toContain('/photo');
    });

    it('is empty without a base url', () => {
        expect(sitemapXml({}, routes)).toBe('');
    });
});

describe('llmsTxt', () => {
    it('renders title, summary, instructions, and pages', () => {
        const txt = llmsTxt(
            {
                url: 'https://x.test',
                title: 'My Site',
                description: 'a site',
                llms: { instructions: 'Be nice.' },
            },
            routes,
        );
        expect(txt).toContain('# My Site');
        expect(txt).toContain('> a site');
        expect(txt).toContain('Be nice.');
        expect(txt).toContain('[Home](https://x.test)');
        expect(txt).toContain('[/about](https://x.test/about)');
    });

    it('is empty when llms: false', () => {
        expect(llmsTxt({ llms: false }, routes)).toBe('');
    });
});

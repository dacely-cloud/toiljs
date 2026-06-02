import { describe, expect, it } from 'vitest';

import { resolveMetadata } from '../src/client/head/metadata';

describe('resolveMetadata', () => {
    it('expands convenience fields into meta/link tags', () => {
        const head = resolveMetadata({
            title: 'About',
            titleTemplate: '%s · toiljs',
            description: 'desc',
            keywords: ['a', 'b'],
            robots: 'noindex',
            themeColor: '#000',
            canonical: 'https://x.test/about',
            openGraph: { title: 'OG', type: 'website', image: 'https://x.test/og.png' },
        });

        expect(head.title).toBe('About');
        expect(head.titleTemplate).toBe('%s · toiljs');
        const byName = (name: string) => head.meta?.find((m) => m.name === name)?.content;
        const byProp = (property: string) =>
            head.meta?.find((m) => m.property === property)?.content;
        expect(byName('description')).toBe('desc');
        expect(byName('keywords')).toBe('a, b');
        expect(byName('robots')).toBe('noindex');
        expect(byName('theme-color')).toBe('#000');
        expect(byProp('og:title')).toBe('OG');
        expect(byProp('og:type')).toBe('website');
        expect(byProp('og:image')).toBe('https://x.test/og.png');
        expect(head.link?.find((l) => l.rel === 'canonical')?.href).toBe('https://x.test/about');
    });

    it('passes through raw meta/link and omits unset fields', () => {
        const head = resolveMetadata({
            title: 'X',
            meta: [{ name: 'author', content: 'me' }],
            link: [{ rel: 'alternate', href: '/rss' }],
        });
        expect(head.meta).toEqual([{ name: 'author', content: 'me' }]);
        expect(head.link).toEqual([{ rel: 'alternate', href: '/rss' }]);
    });
});

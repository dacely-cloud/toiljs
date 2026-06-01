import { describe, expect, it } from 'vitest';

import { fontPreloadTags } from '../src/compiler/fonts';

describe('fontPreloadTags', () => {
    it('builds a crossorigin preload link per font, skipping non-fonts', () => {
        const tags = fontPreloadTags(['fonts/a-abc.woff2', 'assets/x-1.js', 'fonts/b.ttf'], '/');
        expect(tags).toHaveLength(2);
        expect(tags[0]).toEqual({
            tag: 'link',
            attrs: {
                rel: 'preload',
                as: 'font',
                type: 'font/woff2',
                href: '/fonts/a-abc.woff2',
                crossorigin: '',
            },
            injectTo: 'head',
        });
        expect(tags[1].attrs?.type).toBe('font/ttf');
    });

    it('respects a non-root base path', () => {
        expect(fontPreloadTags(['fonts/a.woff2'], '/app/')[0].attrs?.href).toBe('/app/fonts/a.woff2');
    });
});

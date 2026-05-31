import { describe, expect, it } from 'vitest';

import { mergeHead } from '../src/client/head';

describe('mergeHead', () => {
    it('takes the last title and applies a titleTemplate', () => {
        expect(mergeHead([{ title: 'Home' }]).title).toBe('Home');
        expect(mergeHead([{ title: 'A' }, { title: 'B' }]).title).toBe('B');
        expect(mergeHead([{ titleTemplate: '%s · toiljs' }, { title: 'About' }]).title).toBe(
            'About · toiljs',
        );
    });

    it('leaves title undefined when nothing sets it', () => {
        expect(mergeHead([{ meta: [{ name: 'x', content: 'y' }] }]).title).toBeUndefined();
    });

    it('dedupes meta by name/property, last wins', () => {
        const resolved = mergeHead([
            { meta: [{ name: 'description', content: 'old' }] },
            { meta: [{ name: 'description', content: 'new' }, { property: 'og:title', content: 'T' }] },
        ]);
        expect(resolved.meta).toHaveLength(2);
        expect(resolved.meta.find((m) => m.name === 'description')?.content).toBe('new');
        expect(resolved.meta.find((m) => m.property === 'og:title')?.content).toBe('T');
    });

    it('dedupes links by rel+href', () => {
        const resolved = mergeHead([
            { link: [{ rel: 'icon', href: '/a.svg' }] },
            { link: [{ rel: 'icon', href: '/a.svg' }, { rel: 'canonical', href: '/x' }] },
        ]);
        expect(resolved.link).toHaveLength(2);
    });
});

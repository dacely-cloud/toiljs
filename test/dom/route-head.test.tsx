// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { setRouteHead, useHead } from '../../src/client/head/head';
import { resolveMetadata } from '../../src/client/head/metadata';
import { cleanup, render } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
    cleanup();
    setRouteHead(null);
});

const desc = (): string | null =>
    document.head.querySelector('meta[name="description"]')?.getAttribute('content') ?? null;

describe('route head (metadata baseline)', () => {
    it('applies a resolved metadata head to the document', () => {
        setRouteHead(resolveMetadata({ title: 'About', description: 'about page' }));
        expect(document.title).toBe('About');
        expect(desc()).toBe('about page');
    });

    it('is the lowest priority — component useHead overrides it', () => {
        setRouteHead(resolveMetadata({ title: 'Base', description: 'base' }));
        function Page() {
            useHead({ title: 'Override', meta: [{ name: 'description', content: 'override' }] });
            return null;
        }
        render(<Page />);
        expect(document.title).toBe('Override');
        expect(desc()).toBe('override');
    });
});

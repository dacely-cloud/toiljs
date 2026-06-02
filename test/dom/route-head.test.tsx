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

    it("wins over a layout's useHead/<Head> defaults for the keys it sets", () => {
        // A layout default title + a route's metadata title: the route metadata should win.
        function LayoutDefaults() {
            useHead({ title: 'Site Default', meta: [{ name: 'description', content: 'site' }] });
            return null;
        }
        render(<LayoutDefaults />);
        setRouteHead(resolveMetadata({ title: 'useReducer', description: 'route desc' }));
        expect(document.title).toBe('useReducer');
        expect(desc()).toBe('route desc');
    });

    it("applies a layout's titleTemplate to the route's title", () => {
        function LayoutDefaults() {
            useHead({ titleTemplate: '%s · toiljs' });
            return null;
        }
        render(<LayoutDefaults />);
        setRouteHead(resolveMetadata({ title: 'About' }));
        expect(document.title).toBe('About · toiljs');
    });
});

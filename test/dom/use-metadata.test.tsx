// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { Metadata, useMetadata } from '../../src/client/head/metadata';
import { setRouteHead } from '../../src/client/head/head';

afterEach(() => {
    cleanup();
    setRouteHead(null);
});

const meta = (key: string): string | null =>
    document.head.querySelector(`meta[${key}]`)?.getAttribute('content') ?? null;

describe('useMetadata / <Metadata>', () => {
    it('applies a full Metadata object to the document head from a component', () => {
        function Article() {
            useMetadata({
                title: 'Article',
                description: 'an article',
                openGraph: { title: 'og title', type: 'website' },
            });
            return null;
        }
        render(<Article />);
        expect(document.title).toBe('Article');
        expect(meta('name="description"')).toBe('an article');
        expect(meta('property="og:title"')).toBe('og title');
    });

    it('reverts the head when the component unmounts', () => {
        function Article() {
            useMetadata({ title: 'Temp' });
            return null;
        }
        const { unmount } = render(<Article />);
        expect(document.title).toBe('Temp');
        unmount();
        expect(document.title).not.toBe('Temp');
    });

    it('the declarative <Metadata> form applies too', () => {
        render(<Metadata title="Declarative" />);
        expect(document.title).toBe('Declarative');
    });

    it("a route's metadata still wins over a component's useMetadata", () => {
        function Article() {
            useMetadata({ title: 'Component' });
            return null;
        }
        render(<Article />);
        // The route baseline (applied last) takes precedence for keys it sets.
        setRouteHead({ title: 'Route' });
        expect(document.title).toBe('Route');
    });
});

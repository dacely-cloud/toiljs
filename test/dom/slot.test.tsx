// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import { Slot } from '../../src/client/components/Slot';
import { navigate } from '../../src/client/navigation/navigation';
import { Router } from '../../src/client/routing/Router';
import { clearLoaderData } from '../../src/client/routing/loader';
import { SlotContext } from '../../src/client/routing/slot-context';
import type { RouteDef } from '../../src/client/types';

const layoutWithModal = () =>
    Promise.resolve({
        default: ({ children }: { children?: ReactNode }) => (
            <div>
                {children}
                <Slot name="modal" />
            </div>
        ),
    });

afterEach(cleanup);
beforeEach(() => {
    clearLoaderData();
    window.history.replaceState({}, '', '/');
});

describe('Slot', () => {
    it('renders the named slot element from context, or the fallback', () => {
        const { getByText, queryByText } = render(
            <SlotContext.Provider value={{ modal: <span>MODAL</span> }}>
                <Slot name="modal" />
                <Slot name="missing" fallback={<span>FB</span>} />
            </SlotContext.Provider>,
        );
        expect(getByText('MODAL')).toBeTruthy();
        expect(getByText('FB')).toBeTruthy();
        expect(queryByText('missing')).toBeNull();
    });
});

describe('Router parallel slots', () => {
    const routes: RouteDef[] = [
        { pattern: '/', load: () => Promise.resolve({ default: () => <main>PAGE</main> }) },
    ];
    // A layout that renders the page plus the "modal" slot.
    const layout = () =>
        Promise.resolve({
            default: ({ children }: { children?: ReactNode }) => (
                <div>
                    {children}
                    <Slot name="modal" />
                </div>
            ),
        });
    const slots: Record<string, RouteDef[]> = {
        modal: [{ pattern: '/', load: () => Promise.resolve({ default: () => <aside>SLOT</aside> }) }],
    };

    it('renders the main route and a matching slot together', async () => {
        const { findByText } = render(<Router routes={routes} layout={layout} slots={slots} />);
        // Both the page and the parallel slot render for the same URL.
        await findByText('PAGE');
        await findByText('SLOT');
    });
});

describe('intercepting routes', () => {
    const routes: RouteDef[] = [
        { pattern: '/photo/:id', load: () => Promise.resolve({ default: () => <main>PHOTO PAGE</main> }) },
        { pattern: '/', load: () => Promise.resolve({ default: () => <main>FEED</main> }) },
    ];
    const slots: Record<string, RouteDef[]> = {
        modal: [
            {
                pattern: '/photo/:id',
                intercept: true,
                load: () => Promise.resolve({ default: () => <aside>PHOTO MODAL</aside> }),
            },
        ],
    };

    // This test must run before any navigation so it observes a "hard" load (soft-nav state is false).
    it('shows the full page on a hard load (no interception)', async () => {
        window.history.replaceState({}, '', '/photo/1');
        const { findByText, queryByText } = render(
            <Router routes={routes} layout={layoutWithModal} slots={slots} />,
        );
        await findByText('PHOTO PAGE');
        expect(queryByText('PHOTO MODAL')).toBeNull();
    });

    it('intercepts on soft navigation: modal overlays, previous page stays', async () => {
        window.history.replaceState({}, '', '/');
        const { findByText, queryByText } = render(
            <Router routes={routes} layout={layoutWithModal} slots={slots} />,
        );
        await findByText('FEED');
        act(() => {
            navigate('/photo/1');
        });
        // The intercepting slot route shows the modal…
        await findByText('PHOTO MODAL');
        // …while the main view keeps the previous page (the backdrop), not the full photo page.
        expect(queryByText('FEED')).not.toBeNull();
        expect(queryByText('PHOTO PAGE')).toBeNull();
    });
});

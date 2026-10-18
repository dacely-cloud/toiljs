import { clearLoaderData, useLoaderData } from '../../src/client/routing/loader';
import type { ReactNode } from 'react';
// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { navigate } from '../../src/client/navigation/navigation';
import { Router } from '../../src/client/routing/Router';
import type { RouteDef } from '../../src/client/types';

afterEach(cleanup);
beforeEach(() => {
    clearLoaderData();
    window.history.replaceState({}, '', '/');
});

const routes: RouteDef[] = [
    {
        pattern: '/',
        load: () => Promise.resolve({ default: () => <div>HOME</div> }),
    },
    {
        // Page chunk never resolves, so the route stays suspended, exercising the fallback path.
        pattern: '/slow',
        load: () => new Promise<{ default: () => null }>(() => undefined),
        loading: () => Promise.resolve({ default: () => <div>LOADING</div> }),
    },
];

describe('Router loading fallback', () => {
    it('shows loading.tsx while a nested layout loader is pending, then renders its data and page', async (): Promise<void> => {
        const pending: PromiseWithResolvers<string> = Promise.withResolvers<string>();
        function Layout({ children }: { children?: ReactNode }): ReactNode {
            const data: string = useLoaderData<string>();
            return <section><h1>{data}</h1>{children}</section>;
        }
        const layoutRoutes: RouteDef[] = [{
            pattern: '/',
            load: async () => ({ default: () => <p>PAGE READY</p> }),
            layouts: [async () => ({ default: Layout, loader: (): Promise<string> => pending.promise })],
            loading: async () => ({ default: () => <p>LAYOUT LOADING</p> }),
        }];
        const view: ReturnType<typeof render> = render(<Router routes={layoutRoutes} />);
        await view.findByText('LAYOUT LOADING');
        expect(view.queryByText('PAGE READY')).toBeNull();
        await act(async (): Promise<void> => { pending.resolve('LAYOUT READY'); });
        await view.findByText('LAYOUT READY');
        await view.findByText('PAGE READY');
        expect(view.queryByText('LAYOUT LOADING')).toBeNull();
    });

    it("shows the route's loading.tsx immediately when navigating to a suspending route", async () => {
        const { findByText, queryByText } = render(<Router routes={routes} />);
        await findByText('HOME');

        // A route with a `loading.tsx` keys its Suspense boundary per URL, so even though navigation
        // runs in a transition the fallback appears immediately (it isn't suppressed / frozen).
        act(() => {
            navigate('/slow');
        });

        await waitFor(() => {
            expect(queryByText('LOADING')).not.toBeNull();
        });
        // The keyed boundary remounts for the new route, so the previous page is gone (not frozen).
        expect(queryByText('HOME')).toBeNull();
    });
});


it('provides independent loader data to nested layouts and their page', async () => {
    window.history.replaceState({}, '', '/layout-data');
    const layoutLoader = () => 'layout data';
    const pageLoader = () => 'page data';
    function Layout({ children }: { children?: ReactNode }) {
        return <section><h1>{useLoaderData<typeof layoutLoader>()}</h1>{children}</section>;
    }
    function Page() { return <p>{useLoaderData<typeof pageLoader>()}</p>; }
    const { findByText } = render(<Router routes={[{
        pattern: '/layout-data',
        load: () => Promise.resolve({ default: Page, loader: pageLoader }),
        layouts: [() => Promise.resolve({ default: Layout, loader: layoutLoader })],
    }]} />);
    await findByText('layout data');
    await findByText('page data');
});

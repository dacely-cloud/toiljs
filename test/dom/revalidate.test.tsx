// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { Router } from '../../src/client/routing/Router';
import { clearLoaderData, revalidate, useLoaderData } from '../../src/client/routing/loader';
import type { RouteDef } from '../../src/client/types';

afterEach(cleanup);
beforeEach(() => {
    clearLoaderData();
    window.history.replaceState({}, '', '/');
});

describe('revalidate refetches', () => {
    it('re-runs the loader and updates the rendered data', async () => {
        let n = 0;
        function Page(): React.ReactNode {
            const value = useLoaderData<number>();
            return <p>val:{String(value)}</p>;
        }
        const routes: RouteDef[] = [
            {
                pattern: '/',
                load: () => Promise.resolve({ default: Page, loader: () => (n += 1) }),
                // matches the example: this route has a loading.tsx (keyed boundary + transition).
                loading: () => Promise.resolve({ default: () => <p>loading</p> }),
            },
        ];
        const { findByText } = render(<Router routes={routes} />);
        await findByText('val:1');

        act(() => {
            revalidate();
        });
        await findByText('val:2');
    });
});

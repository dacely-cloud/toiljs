// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { navigate } from '../../src/client/navigation/navigation';
import { Router } from '../../src/client/routing/Router';
import type { RouteDef } from '../../src/client/types';

afterEach(cleanup);
beforeEach(() => {
    window.history.replaceState({}, '', '/');
});

const routes: RouteDef[] = [
    {
        pattern: '/',
        load: () => Promise.resolve({ default: () => <div>HOME</div> }),
    },
    {
        // Page chunk never resolves, so the route stays suspended — exercising the fallback path.
        pattern: '/slow',
        load: () => new Promise<{ default: () => null }>(() => undefined),
        loading: () => Promise.resolve({ default: () => <div>LOADING</div> }),
    },
];

describe('Router loading fallback', () => {
    it("shows the route's loading.tsx immediately when navigating to a suspending route", async () => {
        const { findByText, queryByText } = render(<Router routes={routes} />);
        await findByText('HOME');

        // Navigation must NOT be wrapped in a transition: the fallback has to appear right away
        // instead of freezing on the previous page.
        act(() => {
            navigate('/slow');
        });

        await waitFor(() => {
            expect(queryByText('LOADING')).not.toBeNull();
        });
        // We switched instantly into the loading state — React hides the previous page
        // (display:none) rather than leaving it frozen on screen, which a transition would.
        expect(queryByText('HOME')?.style.display).toBe('none');
    });
});

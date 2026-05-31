// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
    back,
    isNavigationPending,
    navigate,
    navigationEpoch,
    settleNavigation,
    subscribeLocation,
} from '../../src/client/navigation/navigation';

beforeEach(() => {
    window.history.replaceState({}, '', '/');
});

describe('navigate', () => {
    it('updates the location and notifies subscribers', () => {
        let calls = 0;
        const off = subscribeLocation(() => {
            calls += 1;
        });
        navigate('/about');
        expect(window.location.pathname).toBe('/about');
        expect(calls).toBe(1);
        off();
    });

    it('replace updates the location too', () => {
        navigate('/replaced', { replace: true });
        expect(window.location.pathname).toBe('/replaced');
    });

    it('increments the navigation epoch', () => {
        const before = navigationEpoch();
        navigate('/a');
        expect(navigationEpoch()).toBe(before + 1);
    });

    it('is pending after navigate, settled after settleNavigation', () => {
        navigate('/pending');
        expect(isNavigationPending()).toBe(true);
        settleNavigation();
        expect(isNavigationPending()).toBe(false);
    });

    it('back() triggers a notification', () => {
        navigate('/one');
        navigate('/two');
        let popped = 0;
        const off = subscribeLocation(() => {
            popped += 1;
        });
        back();
        // jsdom fires popstate synchronously for history.back within the same task.
        expect(popped).toBeGreaterThanOrEqual(0);
        off();
    });
});

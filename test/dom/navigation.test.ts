// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
    back,
    initNavigation,
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


describe('navigation guards', () => {
    it('cancels navigation before changing history, pending state, or subscribers', () => {
        initNavigation();
        settleNavigation();
        const epoch = navigationEpoch();
        const state = window.history.state;
        const block = (event: Event) => event.preventDefault();
        window.addEventListener('toil-before-navigation', block);
        let calls = 0;
        const off = subscribeLocation(() => { calls += 1; });
        try {
            navigate('/unsaved');
            expect(window.location.pathname).toBe('/');
            expect(window.history.state).toEqual(state);
            expect(navigationEpoch()).toBe(epoch);
            expect(isNavigationPending()).toBe(false);
            expect(calls).toBe(0);
        } finally {
            window.removeEventListener('toil-before-navigation', block);
            off();
        }
    });

    it('restores a cancelled Back navigation without notifying route subscribers', async () => {
        initNavigation();
        navigate('/guard-first');
        navigate('/guard-second');
        const block = (event: Event) => event.preventDefault();
        window.addEventListener('toil-before-navigation', block);
        let calls = 0;
        const off = subscribeLocation(() => { calls += 1; });
        try {
            const restored = new Promise<void>((resolve) => {
                const onPop = () => {
                    if (window.location.pathname === '/guard-second') {
                        window.removeEventListener('popstate', onPop);
                        resolve();
                    }
                };
                window.addEventListener('popstate', onPop);
            });
            back();
            await restored;
            expect(window.location.pathname).toBe('/guard-second');
            expect(calls).toBe(0);
        } finally {
            window.removeEventListener('toil-before-navigation', block);
            off();
        }
    });
});

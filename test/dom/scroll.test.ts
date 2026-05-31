// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    applyScroll,
    enableManualScrollRestoration,
    planScroll,
    rememberScroll,
} from '../../src/client/navigation/scroll';

beforeEach(() => {
    window.scrollTo = vi.fn();
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
});

describe('scroll management', () => {
    it('enables manual scroll restoration when the browser supports it', () => {
        // jsdom doesn't implement scrollRestoration; define it so the guarded branch runs.
        (window.history as History & { scrollRestoration: ScrollRestoration }).scrollRestoration =
            'auto';
        enableManualScrollRestoration();
        expect(window.history.scrollRestoration).toBe('manual');
    });

    it('scrolls to top', () => {
        planScroll({ hash: '', toTop: true });
        applyScroll();
        expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('restores a saved position', () => {
        Object.defineProperty(window, 'scrollY', { value: 250, configurable: true });
        rememberScroll('k1');
        planScroll({ restoreKey: 'k1', hash: '', toTop: false });
        applyScroll();
        expect(window.scrollTo).toHaveBeenCalledWith(0, 250);
    });

    it('scrolls to a #hash element', () => {
        const el = document.createElement('div');
        el.id = 'sec';
        el.scrollIntoView = vi.fn();
        document.body.appendChild(el);
        planScroll({ hash: '#sec', toTop: false });
        applyScroll();
        expect(el.scrollIntoView).toHaveBeenCalled();
    });

    it('consumes the plan (second applyScroll is a no-op)', () => {
        planScroll({ hash: '', toTop: true });
        applyScroll();
        (window.scrollTo as ReturnType<typeof vi.fn>).mockClear();
        applyScroll();
        expect(window.scrollTo).not.toHaveBeenCalled();
    });
});

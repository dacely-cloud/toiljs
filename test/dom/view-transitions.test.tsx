// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { navigate, setViewTransitions } from '../../src/client/navigation/navigation';

interface VTDoc {
    startViewTransition?: (cb: () => void) => unknown;
}
const doc = document as Document & VTDoc;

afterEach(() => {
    setViewTransitions(false);
    delete doc.startViewTransition;
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
});

describe('view transitions', () => {
    function stubReducedMotion(matches: boolean): void {
        window.matchMedia = vi
            .fn()
            .mockReturnValue({ matches }) as unknown as typeof window.matchMedia;
    }

    it('wraps navigation in startViewTransition when enabled and supported', () => {
        const vt = vi.fn((cb: () => void) => {
            cb();
        });
        doc.startViewTransition = vt;
        stubReducedMotion(false);
        setViewTransitions(true);
        navigate('/a');
        expect(vt).toHaveBeenCalledOnce();
    });

    it('skips the view transition under prefers-reduced-motion', () => {
        const vt = vi.fn();
        doc.startViewTransition = vt;
        stubReducedMotion(true);
        setViewTransitions(true);
        navigate('/b');
        expect(vt).not.toHaveBeenCalled();
    });

    it('does not use view transitions when disabled', () => {
        const vt = vi.fn();
        doc.startViewTransition = vt;
        stubReducedMotion(false);
        setViewTransitions(false);
        navigate('/c');
        expect(vt).not.toHaveBeenCalled();
    });
});

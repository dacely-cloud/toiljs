// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Script } from '../../src/client/components/Script';

afterEach(cleanup);

const scriptsFor = (key: string): HTMLScriptElement[] =>
    Array.from(document.querySelectorAll<HTMLScriptElement>(`script[data-toil-script="${key}"]`));

describe('Script', () => {
    it('injects an async external script on mount (afterInteractive)', () => {
        render(<Script src="https://cdn.example.com/a.js" />);
        const els = scriptsFor('https://cdn.example.com/a.js');
        expect(els).toHaveLength(1);
        expect(els[0].async).toBe(true);
    });

    it('dedups: the same src is only injected once across instances', () => {
        const src = 'https://cdn.example.com/dedup.js';
        render(
            <>
                <Script src={src} />
                <Script src={src} />
            </>,
        );
        expect(scriptsFor(src)).toHaveLength(1);
    });

    it('injects an inline script body and fires onLoad + onReady', () => {
        const onLoad = vi.fn();
        const onReady = vi.fn();
        render(
            <Script
                id="inline-1"
                onLoad={onLoad}
                onReady={onReady}>
                {'window.__toilTest = 1;'}
            </Script>,
        );
        const els = scriptsFor('inline-1');
        expect(els).toHaveLength(1);
        expect(els[0].textContent).toBe('window.__toilTest = 1;');
        expect(onLoad).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
    });
});

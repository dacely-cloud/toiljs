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

    it('keeps non-executable data blocks inline', () => {
        const onLoad = vi.fn();
        render(
            <Script
                id="json-data"
                type="application/json"
                onLoad={onLoad}>
                {'{"safe":true}'}
            </Script>,
        );
        expect(scriptsFor('json-data')[0].text).toBe('{"safe":true}');
        expect(scriptsFor('json-data')[0].hasAttribute('src')).toBe(false);
        expect(onLoad).toHaveBeenCalledOnce();
    });

    it('rejects non-HTTP URLs even without Trusted Types', () => {
        const onError = vi.fn();
        render(
            <Script
                id="unsafe-url"
                src="data:text/javascript,alert(1)"
                onError={onError}
            />,
        );
        expect(scriptsFor('unsafe-url')).toHaveLength(0);
        expect(onError).toHaveBeenCalledOnce();
    });

    it('injects an inline script body and fires onLoad + onReady', () => {
        const onLoad = vi.fn();
        const onReady = vi.fn();
        const create = vi
            .spyOn(URL, 'createObjectURL')
            .mockReturnValue('blob:https://example.com/inline-1');
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
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
        expect(els[0].src).toBe('blob:https://example.com/inline-1');
        expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
        expect(onLoad).not.toHaveBeenCalled();
        els[0].dispatchEvent(new Event('load'));
        expect(revoke).toHaveBeenCalledWith('blob:https://example.com/inline-1');
        create.mockRestore();
        revoke.mockRestore();
        expect(onLoad).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
    });
});

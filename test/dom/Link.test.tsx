// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Link } from '../../src/client/navigation/Link';

afterEach(cleanup);
beforeEach(() => {
    window.history.replaceState({}, '', '/');
});

describe('Link', () => {
    it('intercepts a plain internal click (client nav, default prevented)', () => {
        const { getByText } = render(<Link href="/about">go</Link>);
        const prevented = !fireEvent.click(getByText('go'));
        expect(prevented).toBe(true);
        expect(window.location.pathname).toBe('/about');
    });

    it('does not intercept external links', () => {
        const { getByText } = render(<Link href="https://example.com">ext</Link>);
        const notPrevented = fireEvent.click(getByText('ext'));
        expect(notPrevented).toBe(true);
        expect(window.location.pathname).toBe('/');
    });

    it('does not intercept modified (cmd/ctrl) clicks', () => {
        const { getByText } = render(<Link href="/about">go</Link>);
        const notPrevented = fireEvent.click(getByText('go'), { metaKey: true });
        expect(notPrevented).toBe(true);
        expect(window.location.pathname).toBe('/');
    });

    it('ignores a click when href is missing (data-driven href to a page that does not exist)', () => {
        // A runtime-undefined href (e.g. `routeMap[missingKey]`) used to throw on `href.startsWith`
        // inside the click handler. React reports a handler throw as an uncaught *window* error (what
        // the dev overlay surfaces), not a synchronous throw, so assert no such error fires. The anchor
        // is inert now: the click is left to the browser, the page stays put.
        const errors: string[] = [];
        const onError = (e: ErrorEvent): void => {
            errors.push(e.message || String(e.error));
        };
        window.addEventListener('error', onError);
        try {
            const { getByText } = render(<Link href={undefined as unknown as string as never}>x</Link>);
            fireEvent.click(getByText('x'));
        } finally {
            window.removeEventListener('error', onError);
        }
        expect(errors).toEqual([]);
        expect(window.location.pathname).toBe('/');
    });

    it('forwards anchor attributes (rel, target)', () => {
        const { getByText } = render(
            <Link
                href="https://x.com"
                target="_blank"
                rel="noopener noreferrer">
                x
            </Link>,
        );
        const a = getByText('x') as HTMLAnchorElement;
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
        expect(a.target).toBe('_blank');
    });
});

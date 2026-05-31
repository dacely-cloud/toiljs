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

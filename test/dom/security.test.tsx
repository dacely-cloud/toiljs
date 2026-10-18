// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { RawHtml } from '../../src/client/ssr/markers';
import { sanitizeHtml } from '../../src/client/html';

afterEach(cleanup);
it('keeps harmless markup and removes executable content from RawHtml', () => {
    const { container } = render(
        <RawHtml
            id="content"
            html={
                '<b>safe</b><img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">link</a>'
            }
        />,
    );
    expect(container.querySelector('b')?.textContent).toBe('safe');
    expect(container.querySelector('script')).toBe(null);
    expect(container.querySelector('img')?.hasAttribute('onerror')).toBe(false);
    expect(container.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(String(sanitizeHtml('<p>hello</p>'))).toBe('<p>hello</p>');
});

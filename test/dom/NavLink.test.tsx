// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NavLink } from '../../src/client/navigation/NavLink';

afterEach(cleanup);

describe('NavLink', () => {
    it('adds the active class + aria-current on the current route', () => {
        window.history.replaceState({}, '', '/about');
        const { getByText } = render(<NavLink href="/about">about</NavLink>);
        const a = getByText('about') as HTMLAnchorElement;
        expect(a.className).toContain('active');
        expect(a.getAttribute('aria-current')).toBe('page');
    });

    it('is not active on a different route', () => {
        window.history.replaceState({}, '', '/home');
        const { getByText } = render(<NavLink href="/about">about</NavLink>);
        const a = getByText('about') as HTMLAnchorElement;
        expect(a.className).not.toContain('active');
        expect(a.getAttribute('aria-current')).toBeNull();
    });

    it('supports a function className', () => {
        window.history.replaceState({}, '', '/about');
        const { getByText } = render(
            <NavLink
                href="/about"
                className={({ isActive }) => (isActive ? 'on' : 'off')}>
                about
            </NavLink>,
        );
        expect((getByText('about') as HTMLAnchorElement).className).toBe('on');
    });
});

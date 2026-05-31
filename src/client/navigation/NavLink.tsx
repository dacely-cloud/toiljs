import type { CSSProperties, ReactNode } from 'react';

import { useLocation } from '../routing/hooks.js';
import { Link, type LinkProps } from './Link.js';

/** State passed to `NavLink`'s function-form `className` / `style` / `children`. */
export interface NavLinkState {
    readonly isActive: boolean;
}

/**
 * Props for {@link NavLink}: all {@link LinkProps}, but `className` / `style` / `children` may also
 * be functions of the active state.
 */
export interface NavLinkProps extends Omit<LinkProps, 'className' | 'style' | 'children'> {
    className?: string | ((state: NavLinkState) => string | undefined);
    style?: CSSProperties | ((state: NavLinkState) => CSSProperties | undefined);
    children?: ReactNode | ((state: NavLinkState) => ReactNode);
    /** Match `href` exactly; without it, sub-paths are also active. Default `false`. */
    end?: boolean;
    /** Class added when active (used with a string `className`). Default `"active"`. */
    activeClassName?: string;
}

function normalizePath(p: string): string {
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * Whether a link to `linkPath` is active for `currentPath`. Exact when `end`; otherwise a parent
 * path is active for its sub-paths (and `/` is active everywhere, matching React Router).
 */
export function matchActive(linkPath: string, currentPath: string, end: boolean): boolean {
    const link = normalizePath(linkPath);
    const current = normalizePath(currentPath);
    if (current === link) return true;
    if (end) return false;
    if (link === '/') return true;
    return current.startsWith(link + '/');
}

/**
 * A {@link Link} that knows whether it points at the current location. Applies an active class
 * (default `"active"`) and `aria-current="page"` when active; `className` / `style` / `children`
 * may be functions of `{ isActive }`. Inherits Link's full anchor API and prefetching.
 */
export function NavLink(props: NavLinkProps): ReactNode {
    const {
        href,
        className,
        style,
        children,
        end = false,
        activeClassName = 'active',
        ...rest
    } = props;
    const pathname = useLocation();

    let linkPath = href;
    try {
        linkPath = new URL(href, window.location.href).pathname;
    } catch {
        linkPath = href;
    }
    const isActive = matchActive(linkPath, pathname, end);
    const state: NavLinkState = { isActive };

    const resolvedClassName =
        typeof className === 'function'
            ? className(state)
            : [className, isActive ? activeClassName : undefined].filter(Boolean).join(' ') ||
              undefined;
    const resolvedStyle = typeof style === 'function' ? style(state) : style;
    const resolvedChildren = typeof children === 'function' ? children(state) : children;

    return (
        <Link
            {...rest}
            href={href}
            className={resolvedClassName}
            style={resolvedStyle}
            aria-current={isActive ? 'page' : undefined}>
            {resolvedChildren}
        </Link>
    );
}

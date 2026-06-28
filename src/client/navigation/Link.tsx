import type { ComponentPropsWithRef, FocusEvent, MouseEvent, PointerEvent, ReactNode } from 'react';

import { navigate } from './navigation.js';
import { prefetch } from './prefetch.js';
import type { Href } from '../types.js';

/**
 * Props for {@link Link}: every standard `<a>` attribute (`rel`, `target`, `download`,
 * `referrerPolicy`, `hrefLang`, `className`, `style`, `ref`, `data-*`, `aria-*`, event handlers …)
 * plus toil's `replace` and `prefetch` controls. `href` is required and typed to the project's routes.
 */
export interface LinkProps extends Omit<ComponentPropsWithRef<'a'>, 'href'> {
    /** Destination. Same-origin hrefs navigate client-side; external / `target` / `download` / `#hash` use the browser. */
    href: Href;
    /** Replace the current history entry instead of pushing a new one. Default `false`. */
    replace?: boolean;
    /** Scroll to top after navigating. Default `true`. */
    scroll?: boolean;
    /** Prefetch the route chunk on hover/focus. Default `true`; `false` opts this link out. */
    prefetch?: boolean;
}

/** True for cross-origin, opaque (`mailto:` / `tel:`), or otherwise non-same-origin hrefs. */
function isExternalHref(href: string): boolean {
    try {
        return new URL(href, window.location.href).origin !== window.location.origin;
    } catch {
        return true;
    }
}

/**
 * Whether `href` is a usable client-navigation target. A data-driven href (`` `routeMap[key]` ``)
 * can resolve to `undefined` / `null` / `''` at runtime when the target page doesn't exist; the
 * resulting anchor is inert, so we must not intercept its click, calling `href.startsWith` /
 * `navigate` on a missing href would throw. `Href` is always a string at the type level, hence the
 * `unknown` parameter, the guard is purely a runtime safety net.
 */
function isNavigableHref(href: unknown): href is string {
    return typeof href === 'string' && href !== '';
}

/**
 * Client-side navigation link. Forwards all anchor attributes to the underlying `<a>`, and
 * prefetches the target route's chunk on hover/focus. Intercepts only plain same-origin clicks ,
 * modified clicks, `target=_blank`, `download`, in-page `#hash`, and external URLs fall through to
 * native browser behavior.
 */
export function Link(props: LinkProps): ReactNode {
    const {
        href,
        replace = false,
        scroll = true,
        prefetch: prefetchProp = true,
        onClick,
        onPointerEnter,
        onFocus,
        children,
        ...rest
    } = props;

    const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
        onClick?.(event);
        if (
            event.defaultPrevented ||
            // A missing href (the target page doesn't exist) makes the anchor inert: leave the click
            // to the browser instead of intercepting it. Checked before `startsWith` so it can't throw.
            !isNavigableHref(href) ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            (rest.target !== undefined && rest.target !== '_self') ||
            rest.download !== undefined ||
            href.startsWith('#') ||
            isExternalHref(href)
        ) {
            return;
        }
        event.preventDefault();
        navigate(href, { replace, scroll });
    };

    const warm = (): void => {
        if (prefetchProp && isNavigableHref(href)) prefetch(href);
    };
    const handlePointerEnter = (event: PointerEvent<HTMLAnchorElement>): void => {
        onPointerEnter?.(event);
        warm();
    };
    const handleFocus = (event: FocusEvent<HTMLAnchorElement>): void => {
        onFocus?.(event);
        warm();
    };

    return (
        <a
            {...rest}
            {...(prefetchProp ? {} : { 'data-no-prefetch': '' })}
            href={href}
            onClick={handleClick}
            onPointerEnter={handlePointerEnter}
            onFocus={handleFocus}>
            {children}
        </a>
    );
}

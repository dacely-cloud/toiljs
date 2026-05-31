/**
 * Router hooks for user route components: read the params / pathname / search params, navigate
 * imperatively, and grab a router handle.
 */
import { startTransition, useContext, useEffect, useReducer } from 'react';

import type { RouteParams } from './match.js';
import {
    back,
    forward,
    navigate,
    refresh,
    subscribeLocation,
    type NavigateOptions,
} from './navigation.js';
import { ParamsContext } from './params-context.js';
import { prefetch } from './prefetch.js';

/** Imperative router handle returned by {@link useRouter}. */
export interface RouterInstance {
    /** Navigate to `href`, pushing a new history entry (or replacing with `{ replace: true }`). */
    push(href: string, options?: NavigateOptions): void;
    /** Navigate to `href`, replacing the current history entry. */
    replace(href: string): void;
    /** Go back one history entry. */
    back(): void;
    /** Go forward one history entry. */
    forward(): void;
    /** Re-render the current route. */
    refresh(): void;
    /** Prefetch a route's chunk ahead of navigation. */
    prefetch(href: string): void;
}

const ROUTER: RouterInstance = {
    push: (href, options) => {
        navigate(href, options);
    },
    replace: (href) => {
        navigate(href, { replace: true });
    },
    back,
    forward,
    refresh,
    prefetch,
};

/** Current dynamic route params, e.g. `{ id }` inside `/blog/:id`. */
export function useParams(): RouteParams {
    return useContext(ParamsContext);
}

/** Returns the imperative `navigate(href, { replace })` function. */
export function useNavigate(): typeof navigate {
    return navigate;
}

/** Returns the router handle (`push` / `replace` / `back` / `forward` / `refresh` / `prefetch`). */
export function useRouter(): RouterInstance {
    return ROUTER;
}

/**
 * Subscribes to location changes (in a transition, so the current page stays on screen while the
 * next chunk loads) and reads the live `window.location` on render. Re-renders on any pathname,
 * search, or hash change.
 */
function useLocationSubscription(): void {
    const [, forceUpdate] = useReducer((n: number): number => n + 1, 0);
    useEffect(
        () =>
            subscribeLocation(() => {
                startTransition(() => {
                    forceUpdate();
                });
            }),
        [],
    );
}

/** Subscribes to and returns the current `location.pathname`. */
export function useLocation(): string {
    useLocationSubscription();
    return window.location.pathname;
}

/** Alias of {@link useLocation}: the current `location.pathname`. */
export function usePathname(): string {
    return useLocation();
}

/** The current query string as a `URLSearchParams`, re-read on every navigation. */
export function useSearchParams(): URLSearchParams {
    useLocationSubscription();
    return new URLSearchParams(window.location.search);
}

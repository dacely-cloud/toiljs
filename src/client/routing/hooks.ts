/**
 * Router hooks for user route components: read the params / pathname / search params, navigate
 * imperatively, and grab a router handle.
 */
import {
    startTransition,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    useSyncExternalStore,
} from 'react';

import type { RouteParams } from './match.js';
import {
    back,
    forward,
    isNavigationPending,
    navigate,
    refresh,
    subscribeLocation,
    subscribePending,
    type NavigateOptions,
} from '../navigation/navigation.js';
import { clearLoaderData } from './loader.js';
import { ParamsContext } from './params-context.js';
import { prefetch } from '../navigation/prefetch.js';

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
    /** Re-render the current route and re-run its loader. */
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
    refresh: () => {
        clearLoaderData();
        refresh();
    },
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
    const search = window.location.search;
    return useMemo(() => new URLSearchParams(search), [search]);
}

/** True while a navigation is in flight (started but not yet committed) — e.g. for a loading bar. */
export function useNavigationPending(): boolean {
    return useSyncExternalStore(
        subscribePending,
        isNavigationPending,
        () => false,
    );
}

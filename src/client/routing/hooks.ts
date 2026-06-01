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
import { clearLoaderData, revalidate as revalidateData } from './loader.js';
import { ParamsContext } from './params-context.js';
import { prefetch } from '../navigation/prefetch.js';
import type { Href } from '../types.js';

/** Imperative router handle returned by {@link useRouter}. */
export interface RouterInstance {
    /** Navigate to `href`, pushing a new history entry (or replacing with `{ replace: true }`). */
    push(href: Href, options?: NavigateOptions): void;
    /** Navigate to `href`, replacing the current history entry. */
    replace(href: Href): void;
    /** Go back one history entry. */
    back(): void;
    /** Go forward one history entry. */
    forward(): void;
    /** Re-render the current route and re-run its loader (clears all cached loader data). */
    refresh(): void;
    /**
     * Invalidate cached loader data and re-render so it refetches. No argument refetches the active
     * route; pass an `href` to target a specific route. Use after a mutation.
     */
    revalidate(href?: Href): void;
    /** Prefetch a route's chunk ahead of navigation. */
    prefetch(href: Href): void;
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
    revalidate: (href) => {
        revalidateData(href);
    },
    prefetch,
};

/** Current dynamic route params, e.g. `{ id }` inside `/blog/:id`. Pass a shape: `useParams<{ id: string }>()`. */
export function useParams<T extends RouteParams = RouteParams>(): T {
    return useContext(ParamsContext) as T;
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
 * Subscribes to location changes and reads the live `window.location` on render. Re-renders on any
 * pathname, search, or hash change.
 *
 * The update runs in a `startTransition` so navigation is smooth: React keeps the current page on
 * screen while the next route's chunk/data load, instead of flashing a blank fallback. Routes that
 * define a `loading.tsx` opt back into an immediate loading state, the Router keys their Suspense
 * boundary per navigation, so the fallback shows even within the transition (no frozen page). Warm
 * routes (prefetched, no loader) render synchronously and commit instantly.
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

/** True while a navigation is in flight (started but not yet committed), e.g. for a loading bar. */
export function useNavigationPending(): boolean {
    return useSyncExternalStore(
        subscribePending,
        isNavigationPending,
        () => false,
    );
}

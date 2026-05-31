/**
 * Route data loaders. A route file may export a `loader` alongside its default component; the
 * loader runs on navigation, in parallel with the route's chunk load, and the page suspends until
 * it resolves (so `loading.tsx` shows and `useNavigationPending` is true). The page reads the
 * result with `useLoaderData()`. Results are cached per navigation+URL (revalidated on each
 * navigation); `clearLoaderData()` (router.refresh) busts the cache.
 */
import { createContext, useContext, type ComponentType } from 'react';

import { navigationEpoch } from '../navigation/navigation.js';
import type { RouteDef } from '../types.js';
import type { RouteParams } from './match.js';

/** Argument passed to a route `loader`. */
export interface LoaderArgs {
    readonly params: RouteParams;
    readonly searchParams: URLSearchParams;
}

/** A route `loader`: `export const loader = ({ params }) => …` (sync or async). */
export type LoaderFunction<T = unknown> = (args: LoaderArgs) => T | Promise<T>;

interface RouteModule {
    default: ComponentType;
    loader?: LoaderFunction;
}
interface RouteData {
    Component: ComponentType;
    data: unknown;
}
interface Entry {
    status: 'pending' | 'done' | 'error';
    promise: Promise<void>;
    value?: RouteData;
    error?: unknown;
}

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 16;

/** Loads the route module and runs its loader (if any), in parallel where possible. */
async function loadRoute(route: RouteDef, params: RouteParams): Promise<RouteData> {
    const mod: RouteModule = await route.load();
    const searchParams = new URLSearchParams(
        typeof window === 'undefined' ? '' : window.location.search,
    );
    const data = mod.loader ? await mod.loader({ params, searchParams }) : undefined;
    return { Component: mod.default, data };
}

/** Drops entries from previous navigations (and caps the cache as a backstop). */
function prune(): void {
    const current = `${String(navigationEpoch())}:`;
    for (const key of cache.keys()) {
        if (!key.startsWith(current)) cache.delete(key);
    }
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

/**
 * Reads (or starts) the route's module + loader data for `key`, suspending until ready. Throws the
 * loader's error so the route's `error.tsx` boundary can catch it.
 */
export function readRouteData(route: RouteDef, params: RouteParams, key: string): RouteData {
    let entry = cache.get(key);
    if (!entry) {
        const created: Entry = { status: 'pending', promise: Promise.resolve() };
        created.promise = loadRoute(route, params).then(
            (value) => {
                created.value = value;
                created.status = 'done';
            },
            (error: unknown) => {
                created.error = error;
                created.status = 'error';
            },
        );
        cache.set(key, created);
        prune();
        entry = created;
    }
    if (entry.status === 'pending') throw entry.promise;
    if (entry.status === 'error') throw entry.error;
    return entry.value as RouteData;
}

/** Clears all cached loader data, so the next render re-runs loaders (used by router.refresh). */
export function clearLoaderData(): void {
    cache.clear();
}

/** Holds the active route's loader data; provided by the Router, read by {@link useLoaderData}. */
export const LoaderDataContext = createContext<unknown>(undefined);

/** The data returned by the active route's `loader` (`undefined` if it has none). */
export function useLoaderData<T = unknown>(): T {
    return useContext(LoaderDataContext) as T;
}

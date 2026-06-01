/**
 * Route data loaders. A route file may export a `loader` alongside its default component; the
 * loader runs on navigation, in parallel with the route's chunk load, and the page suspends until
 * it resolves (so `loading.tsx` shows and `useNavigationPending` is true). The page reads the
 * result with `useLoaderData<typeof loader>()`.
 *
 * Caching: results are cached by URL (`pathname + search`). Re-renders reuse the cached result (the
 * loader does not re-run). Across navigations, the cache policy comes from the route's optional
 * `export const revalidate` ({@link Revalidate}): by default the loader re-runs on every navigation;
 * a number keeps data fresh for that many seconds; `false` caches until manual invalidation.
 * `revalidate()` / `router.refresh()` bust the cache to force a refetch.
 */
import { createContext, useContext, type ComponentType } from 'react';

import type { HeadSpec } from '../head/head.js';
import { resolveMetadata, type GenerateMetadata, type Metadata } from '../head/metadata.js';
import { refresh as rerender } from '../navigation/navigation.js';
import type { RouteDef } from '../types.js';
import type { RouteParams } from './match.js';

/** Argument passed to a route `loader`. */
export interface LoaderArgs {
    readonly params: RouteParams;
    readonly searchParams: URLSearchParams;
}

/** A route `loader`: `export const loader = ({ params }) => …` (sync or async). */
export type LoaderFunction<T = unknown> = (args: LoaderArgs) => T | Promise<T>;

/**
 * Per-route cache policy, set with `export const revalidate` in a route file:
 * - `0` (default): re-run the loader on every navigation to the route.
 * - a positive number: reuse cached data across navigations for that many **seconds**, then refetch.
 * - `false`: cache indefinitely until manually invalidated (`revalidate()` / `router.refresh()`).
 */
export type Revalidate = number | false;

/** Resolves the data type for {@link useLoaderData}: `typeof loader` → its (awaited) return, else `T`. */
export type LoaderData<T> = T extends (...args: never[]) => infer R ? Awaited<R> : T;

interface RouteModule {
    default: ComponentType;
    loader?: LoaderFunction;
    revalidate?: Revalidate;
    metadata?: Metadata;
    generateMetadata?: GenerateMetadata;
}
interface RouteData {
    Component: ComponentType;
    data: unknown;
    /** Resolved baseline head from the route's `metadata` / `generateMetadata`, if any. */
    head?: HeadSpec;
}
interface Entry {
    status: 'pending' | 'done' | 'error';
    promise: Promise<void>;
    value?: RouteData;
    error?: unknown;
    /** `Date.now()` when the fetch settled (`0` while pending). */
    loadedAt: number;
    /** Cache policy captured from the route module once loaded. */
    revalidate: Revalidate;
    /** Navigation epoch at which this entry was (re)fetched. */
    epoch: number;
    /** Whether the route exports a `loader` — a route without one has no data that can change. */
    hasLoader: boolean;
}

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 32;

/** Cache key for a URL: path + query (hash is ignored — it never changes loader data). */
export function loaderKey(pathname: string, search: string): string {
    return `${pathname}${search}`;
}

/** Loads the route module and runs its loader (if any), in parallel where possible. */
async function loadRoute(
    route: RouteDef,
    params: RouteParams,
): Promise<{ data: RouteData; revalidate: Revalidate; hasLoader: boolean }> {
    const mod: RouteModule = await route.load();
    const searchParams = new URLSearchParams(
        typeof window === 'undefined' ? '' : window.location.search,
    );
    const data = mod.loader ? await mod.loader({ params, searchParams }) : undefined;
    let head: HeadSpec | undefined;
    if (mod.generateMetadata) {
        head = resolveMetadata(await mod.generateMetadata({ params, searchParams, data }));
    } else if (mod.metadata) {
        head = resolveMetadata(mod.metadata);
    }
    return {
        data: { Component: mod.default, data, head },
        revalidate: mod.revalidate ?? 0,
        hasLoader: mod.loader != null,
    };
}

/** Whether a settled entry must be refetched for the current navigation. */
function isStale(entry: Entry, epoch: number): boolean {
    if (entry.status === 'error') return true; // always retry a failed load
    // A route with no loader has no data that can change — keep it cached so repeat navigations
    // render synchronously (instant) instead of re-suspending and remounting on every switch.
    if (!entry.hasLoader) return false;
    if (entry.revalidate === false) return false; // cache forever
    if (entry.revalidate === 0) return entry.epoch !== epoch; // refetch once per navigation
    return Date.now() - entry.loadedAt >= entry.revalidate * 1000; // time-based staleness
}

/** Starts (and caches) a fresh fetch for `key`. */
function startFetch(route: RouteDef, params: RouteParams, key: string, epoch: number): Entry {
    const created: Entry = {
        status: 'pending',
        promise: Promise.resolve(),
        loadedAt: 0,
        revalidate: 0,
        epoch,
        hasLoader: false,
    };
    created.promise = loadRoute(route, params).then(
        (result) => {
            created.value = result.data;
            created.revalidate = result.revalidate;
            created.hasLoader = result.hasLoader;
            created.loadedAt = Date.now();
            created.status = 'done';
        },
        (error: unknown) => {
            created.error = error;
            created.loadedAt = Date.now();
            created.status = 'error';
        },
    );
    cache.set(key, created);
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined || oldest === key) break;
        cache.delete(oldest);
    }
    return created;
}

/**
 * Reads (or starts) the route's module + loader data for the URL `key`, suspending until ready.
 * Throws the loader's error so the route's `error.tsx` boundary can catch it. `epoch` is the current
 * navigation epoch, used to refetch once-per-navigation under the default cache policy.
 */
export function readRouteData(
    route: RouteDef,
    params: RouteParams,
    key: string,
    epoch: number,
): RouteData {
    let entry = cache.get(key);
    if (entry && entry.status !== 'pending' && isStale(entry, epoch)) {
        entry = undefined; // stale → drop and refetch below
    }
    entry ??= startFetch(route, params, key, epoch);
    if (entry.status === 'pending') throw entry.promise;
    if (entry.status === 'error') throw entry.error;
    if (!entry.value) throw entry.promise;
    return entry.value;
}

/** Clears all cached loader data, so the next render re-runs loaders (used by router.refresh). */
export function clearLoaderData(): void {
    cache.clear();
}

/** Cache key for an href (relative or absolute), matching {@link loaderKey}. */
function keyForHref(href: string): string | undefined {
    if (typeof window === 'undefined') return undefined;
    try {
        const url = new URL(href, window.location.href);
        return loaderKey(url.pathname, url.search);
    } catch {
        return undefined;
    }
}

/**
 * Invalidates cached loader data so it refetches on the next render. With no argument, clears every
 * route; with an `href`, clears just that route's entry. Pair with a re-render (the active route
 * refetches and suspends) — see {@link revalidate}.
 */
export function invalidateLoaderData(href?: string): void {
    if (href === undefined) {
        cache.clear();
        return;
    }
    const key = keyForHref(href);
    if (key !== undefined) cache.delete(key);
}

/**
 * Invalidates loader data and re-renders so the active route refetches. Call after a mutation to
 * refresh the current route (`revalidate()`), or target another route by href
 * (`revalidate('/posts')`). Usable outside React (e.g. in an event handler after a `fetch`).
 */
export function revalidate(href?: string): void {
    invalidateLoaderData(href);
    rerender();
}

/** Holds the active route's loader data; provided by the Router, read by {@link useLoaderData}. */
export const LoaderDataContext = createContext<unknown>(undefined);

/**
 * The data returned by the active route's `loader`. Three ways to type it, easiest first:
 *
 * 1. **Pass the loader** — zero generics, fully inferred from your loader's return:
 *    `const data = useLoaderData(loader);`
 * 2. Pass `typeof loader` as a type argument: `useLoaderData<typeof loader>();`
 * 3. Pass an explicit shape: `useLoaderData<Post>();`
 *
 * With no argument and no type, it returns `unknown` (never `any`) — so the data is there at runtime,
 * but you must annotate or narrow before using it. There's no way to infer the type from a bare call:
 * TypeScript can't tell which file (and so which `loader`) the call belongs to — hence option 1.
 */
export function useLoaderData<L extends LoaderFunction>(loader: L): Awaited<ReturnType<L>>;
export function useLoaderData<T = unknown>(): LoaderData<T>;
export function useLoaderData(_loader?: LoaderFunction): unknown {
    return useContext(LoaderDataContext);
}

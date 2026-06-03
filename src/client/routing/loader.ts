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
import { navigationEpoch, refresh as rerender } from '../navigation/navigation.js';
import type { RouteDef } from '../types.js';
import type { RouteParams } from './match.js';

/** Argument passed to a route `loader`. */
export interface LoaderArgs {
    readonly params: RouteParams;
    readonly searchParams: URLSearchParams;
}

/** A route `loader`: `export const loader = ({ params }) => …` (sync or async). */
export type LoaderFunction<T = unknown> = (args: LoaderArgs) => T | Promise<T>;

/** One concrete set of route params (a dynamic segment maps to a string, a catch-all to a string[]). */
export type StaticParams = Record<string, string | string[]>;

/**
 * A route's `export const generateStaticParams`: returns the concrete param sets to pre-render at
 * build time (SSG). toil enumerates them, runs the route's `generateMetadata` per set, and bakes a
 * `<url>/index.html` + sitemap entry for each, so dynamic routes get build-time SEO. Build-only.
 */
export type GenerateStaticParams = () => StaticParams[] | Promise<StaticParams[]>;

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
    /** Whether the route exports a `loader`, a route without one has no data that can change. */
    hasLoader: boolean;
    /**
     * Fetched ahead of navigation (hover/visible prefetch), not yet consumed by a navigation. Such an
     * entry is reused once by the next navigation even under `revalidate: 0`, then behaves normally.
     */
    prefetched: boolean;
}

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 32;

// Dev-cache observers (the dev toolbar's Data tab). The emit calls are no-ops in production builds,
// where the toolbar (the only subscriber) is dead-code-eliminated.
const cacheListeners = new Set<() => void>();
// Cached snapshot for useSyncExternalStore: getSnapshot must return a stable reference between
// changes, so we recompute only when the cache mutates (in emitCache), not on every read. Returning
// a fresh array per call makes React think the store changed every render -> infinite loop.
let cacheSnapshot: LoaderCacheSnapshot[] = [];
function emitCache(): void {
    cacheSnapshot = [...cache.entries()].map(([key, e]) => ({
        key,
        status: e.status,
        hasLoader: e.hasLoader,
        revalidate: e.revalidate,
        loadedAt: e.loadedAt,
        epoch: e.epoch,
        data: e.value?.data,
    }));
    for (const l of cacheListeners) l();
}
/** Subscribes to loader-cache changes (dev toolbar). Returns an unsubscribe. */
export function subscribeLoaderCache(listener: () => void): () => void {
    cacheListeners.add(listener);
    return () => {
        cacheListeners.delete(listener);
    };
}
/** A read-only snapshot of one cached loader entry (dev toolbar). */
export interface LoaderCacheSnapshot {
    readonly key: string;
    readonly status: Entry['status'];
    readonly hasLoader: boolean;
    readonly revalidate: Revalidate;
    readonly loadedAt: number;
    readonly epoch: number;
    readonly data: unknown;
}
/** Snapshots the live loader cache (dev toolbar). Returns a stable reference between changes. */
export function inspectLoaderCache(): LoaderCacheSnapshot[] {
    return cacheSnapshot;
}

/** Cache key for a URL: path + query (hash is ignored, it never changes loader data). */
export function loaderKey(pathname: string, search: string): string {
    return `${pathname}${search}`;
}

/**
 * Warms a route's chunk *and* loader data for a URL ahead of navigation (the prefetcher calls this on
 * link hover/focus), so the eventual click commits synchronously instead of suspending. The entry is
 * flagged `prefetched` so the next navigation reuses it once even under the default `revalidate: 0`.
 * No-op when the URL is already cached or its fetch is already in flight. Errors are swallowed into
 * the entry (the real navigation will retry and surface them via the route's `error.tsx`).
 */
export function prefetchRouteData(
    route: RouteDef,
    params: RouteParams,
    pathname: string,
    search: string,
): void {
    const key = loaderKey(pathname, search);
    const existing = cache.get(key);
    if (existing && existing.status !== 'error') return;
    startFetch(route, params, key, navigationEpoch(), search, true);
}

/** Loads the route module and runs its loader (if any), in parallel where possible. */
async function loadRoute(
    route: RouteDef,
    params: RouteParams,
    search: string,
): Promise<{ data: RouteData; revalidate: Revalidate; hasLoader: boolean }> {
    const mod: RouteModule = await route.load();
    const searchParams = new URLSearchParams(search);
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
    // A route with no loader has no data that can change, keep it cached so repeat navigations
    // render synchronously (instant) instead of re-suspending and remounting on every switch.
    if (!entry.hasLoader) return false;
    if (entry.revalidate === false) return false; // cache forever
    if (entry.revalidate === 0) {
        // A just-prefetched entry is the fetch for this very navigation, reuse it once (consumed in
        // readRouteData, so the *next* navigation refetches as `revalidate: 0` normally requires).
        if (entry.prefetched) return false;
        return entry.epoch !== epoch; // otherwise refetch once per navigation
    }
    return Date.now() - entry.loadedAt >= entry.revalidate * 1000; // time-based staleness
}

/** Starts (and caches) a fresh fetch for `key`. */
function startFetch(
    route: RouteDef,
    params: RouteParams,
    key: string,
    epoch: number,
    search: string,
    prefetched = false,
): Entry {
    const created: Entry = {
        status: 'pending',
        promise: Promise.resolve(),
        loadedAt: 0,
        revalidate: 0,
        epoch,
        hasLoader: false,
        prefetched,
    };
    created.promise = loadRoute(route, params, search).then(
        (result) => {
            created.value = result.data;
            created.revalidate = result.revalidate;
            created.hasLoader = result.hasLoader;
            created.loadedAt = Date.now();
            created.status = 'done';
            emitCache();
        },
        (error: unknown) => {
            created.error = error;
            created.loadedAt = Date.now();
            created.status = 'error';
            emitCache();
        },
    );
    cache.set(key, created);
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined || oldest === key) break;
        cache.delete(oldest);
    }
    emitCache();
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
    const search = typeof window === 'undefined' ? '' : window.location.search;
    let entry = cache.get(key);
    if (entry && entry.status !== 'pending' && isStale(entry, epoch)) {
        entry = undefined; // stale → drop and refetch below
    }
    entry ??= startFetch(route, params, key, epoch, search);
    if (entry.status === 'pending') throw entry.promise;
    if (entry.status === 'error') throw entry.error;
    if (!entry.value) throw entry.promise;
    // Claim a prefetched entry for this navigation: clear the flag and stamp the current epoch so the
    // next navigation re-evaluates its revalidate policy (a `revalidate: 0` route refetches again).
    if (entry.prefetched) {
        entry.prefetched = false;
        entry.epoch = epoch;
    }
    return entry.value;
}

/** Clears all cached loader data, so the next render re-runs loaders (used by router.refresh). */
export function clearLoaderData(): void {
    cache.clear();
    emitCache();
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
 * refetches and suspends), see {@link revalidate}.
 */
export function invalidateLoaderData(href?: string): void {
    if (href === undefined) {
        cache.clear();
        emitCache();
        return;
    }
    const key = keyForHref(href);
    if (key !== undefined) cache.delete(key);
    emitCache();
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
 * 1. **Pass the loader**, zero generics, fully inferred from your loader's return:
 *    `const data = useLoaderData(loader);`
 * 2. Pass `typeof loader` as a type argument: `useLoaderData<typeof loader>();`
 * 3. Pass an explicit shape: `useLoaderData<Post>();`
 *
 * With no argument and no type, it returns `unknown` (never `any`), so the data is there at runtime,
 * but you must annotate or narrow before using it. There's no way to infer the type from a bare call:
 * TypeScript can't tell which file (and so which `loader`) the call belongs to, hence option 1.
 */
export function useLoaderData<L extends LoaderFunction>(loader: L): Awaited<ReturnType<L>>;
export function useLoaderData<T = unknown>(): LoaderData<T>;
export function useLoaderData(_loader?: LoaderFunction): unknown {
    return useContext(LoaderDataContext);
}

/**
 * Lazy-component resolution and caching. Each page/layout/not-found loader is wrapped in
 * `React.lazy` exactly once and memoized, so re-renders reuse the same component (and React's
 * Suspense cache) instead of re-creating it. Keyed by loader identity.
 */
import { type ComponentType, lazy, type ReactNode } from 'react';

import type {
    LayoutComponentLoader,
    LayoutLoader,
    NotFoundLoader,
    RouteErrorProps,
} from '../types.js';

type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

/** Memoizes `lazy()` per loader identity in `cache`. */
function memoLazy<P>(cache: Map<Loader<P>, ComponentType<P>>, loader: Loader<P>): ComponentType<P> {
    let component = cache.get(loader);
    if (!component) {
        component = lazy(loader);
        cache.set(loader, component);
    }
    return component;
}

const loadingCache = new Map<Loader<object>, ComponentType<object>>();
/** Memoized lazy component for a route's `loading.tsx`. */
export function loadingComponent(loader: Loader<object>): ComponentType<object> {
    return memoLazy(loadingCache, loader);
}

const errorCache = new Map<Loader<RouteErrorProps>, ComponentType<RouteErrorProps>>();
/** Memoized lazy component for a route's `error.tsx`. */
export function errorComponent(loader: Loader<RouteErrorProps>): ComponentType<RouteErrorProps> {
    return memoLazy(errorCache, loader);
}

let layoutComponent: ComponentType<{ children?: ReactNode }> | null = null;
let layoutLoader: LayoutLoader = null;

/** Returns the memoized lazy root-layout component, rebuilding only if the loader identity changes. */
export function resolveLayout(
    loader: NonNullable<LayoutLoader>,
): ComponentType<{ children?: ReactNode }> {
    if (layoutLoader !== loader || !layoutComponent) {
        layoutComponent = lazy(loader);
        layoutLoader = loader;
    }
    return layoutComponent;
}

const nestedLayoutCache = new Map<LayoutComponentLoader, ComponentType<{ children?: ReactNode }>>();

/** Returns the memoized lazy component for a nested layout loader, keyed by loader identity. */
export function nestedLayout(
    loader: LayoutComponentLoader,
): ComponentType<{ children?: ReactNode }> {
    let component = nestedLayoutCache.get(loader);
    if (!component) {
        component = lazy(loader);
        nestedLayoutCache.set(loader, component);
    }
    return component;
}

let notFoundComponent: ComponentType | null = null;
let notFoundLoader: NotFoundLoader = null;

/** Returns the memoized lazy not-found component, rebuilding only if the loader identity changes. */
export function resolveNotFound(loader: NonNullable<NotFoundLoader>): ComponentType {
    if (notFoundLoader !== loader || !notFoundComponent) {
        notFoundComponent = lazy(loader);
        notFoundLoader = loader;
    }
    return notFoundComponent;
}

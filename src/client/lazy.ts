/**
 * Lazy-component resolution and caching. Each page/layout/not-found loader is wrapped in
 * `React.lazy` exactly once and memoized, so re-renders reuse the same component (and React's
 * Suspense cache) instead of re-creating it. Keyed by loader identity.
 */
import { lazy, type ComponentType, type ReactNode } from 'react';

import type { LayoutLoader, NotFoundLoader, RouteDef } from './types.js';

const pageCache = new Map<RouteDef, ComponentType>();

/** Returns the memoized lazy component for `route`, creating it on first use. */
export function pageComponent(route: RouteDef): ComponentType {
    let component = pageCache.get(route);
    if (!component) {
        component = lazy(route.load);
        pageCache.set(route, component);
    }
    return component;
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

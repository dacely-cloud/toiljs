import { createElement, Suspense, useLayoutEffect, type ReactNode } from 'react';

import { ErrorBoundary } from './error-boundary.js';
import { useLocation } from './hooks.js';
import {
    errorComponent,
    loadingComponent,
    nestedLayout,
    resolveLayout,
    resolveNotFound,
} from './lazy.js';
import { loaderKey, LoaderDataContext, readRouteData } from './loader.js';
import { matchRoute, type RouteParams } from './match.js';
import { useRouteHead } from '../head/head.js';
import { ParamsContext } from './params-context.js';
import { SlotContext } from './slot-context.js';
import {
    isSoftNavigation,
    navigationEpoch,
    previousPathname,
    settleNavigation,
} from '../navigation/navigation.js';
import { applyScroll } from '../navigation/scroll.js';
import type { ErrorComponentLoader, LayoutLoader, NotFoundLoader, RouteDef } from '../types.js';

/** Loads a matched route's module + loader data (suspending), then renders it with the data in context. */
function RoutePage(props: {
    route: RouteDef;
    params: RouteParams;
    dataKey: string;
    epoch: number;
}): ReactNode {
    const { Component, data, head } = readRouteData(props.route, props.params, props.dataKey, props.epoch);
    useRouteHead(head);
    return <LoaderDataContext.Provider value={data}>{createElement(Component)}</LoaderDataContext.Provider>;
}

/**
 * Wraps a matched route's page in its loading boundary, templates, nested layouts, and error
 * boundary. `keyPrefix` namespaces the loader-cache key and boundary keys so a parallel slot and the
 * main route can match the same URL without colliding.
 */
function renderMatched(
    matched: RouteDef,
    params: RouteParams,
    pathname: string,
    epoch: number,
    keyPrefix: string,
): ReactNode {
    const search = typeof window === 'undefined' ? '' : window.location.search;
    const dataKey = keyPrefix + loaderKey(pathname, search);
    const fallback: ReactNode = matched.loading
        ? createElement(Suspense, { fallback: null }, createElement(loadingComponent(matched.loading)))
        : null;

    // A route with a `loading.tsx` keys its boundary per URL so the fallback shows even inside the
    // navigation transition; one without keeps a stable boundary so the transition holds the old page.
    let content: ReactNode = (
        <Suspense
            key={matched.loading ? dataKey : undefined}
            fallback={fallback}>
            <RoutePage
                route={matched}
                params={params}
                dataKey={dataKey}
                epoch={epoch}
            />
        </Suspense>
    );
    // Templates wrap inside the layouts and re-mount on every navigation (keyed by URL).
    const templates = matched.templates ?? [];
    for (let i = templates.length - 1; i >= 0; i--) {
        const Template = nestedLayout(templates[i]);
        content = (
            <Suspense
                key={`${keyPrefix}${pathname}:${String(i)}`}
                fallback={null}>
                <Template>{content}</Template>
            </Suspense>
        );
    }
    // Nested layouts, deepest first so the shallowest ends up outermost.
    const chain = matched.layouts ?? [];
    for (let i = chain.length - 1; i >= 0; i--) {
        const NestedLayout = nestedLayout(chain[i]);
        content = (
            <Suspense fallback={null}>
                <NestedLayout>{content}</NestedLayout>
            </Suspense>
        );
    }
    if (matched.errorComponent) {
        content = <ErrorBoundary fallback={errorComponent(matched.errorComponent)}>{content}</ErrorBoundary>;
    }
    return content;
}

/**
 * Finds the first route (already specificity-sorted) matching `pathname`. Intercepting routes are
 * skipped unless `allowIntercept` — they only apply on soft navigation.
 */
function match(
    routes: RouteDef[],
    pathname: string,
    allowIntercept = true,
): { route: RouteDef; params: RouteParams } | null {
    for (const route of routes) {
        if (route.intercept && !allowIntercept) continue;
        const params = matchRoute(route.pattern, pathname);
        if (params) return { route, params };
    }
    return null;
}

/** Matches the current location to a route and renders it, optionally wrapped in the root layout. */
export function Router(props: {
    routes: RouteDef[];
    layout?: LayoutLoader;
    notFound?: NotFoundLoader;
    globalError?: ErrorComponentLoader;
    slots?: Record<string, RouteDef[]>;
}): ReactNode {
    const { routes, layout = null, notFound = null, globalError = null, slots = {} } = props;
    const pathname = useLocation();

    // After each navigation commits, apply the planned scroll (top / restore / #hash) and mark the
    // navigation settled. A layout effect runs before paint, so the scroll lands without a flash.
    useLayoutEffect(() => {
        applyScroll();
        settleNavigation();
    });

    const epoch = navigationEpoch();
    const soft = isSoftNavigation();

    // Parallel slots: each `@slot` tree matches the current URL independently (intercepting routes
    // only on soft navigation). Each match is exposed by name via SlotContext and rendered wherever a
    // layout/page places a `Slot`. If an intercepting route matches, the main view holds the previous
    // page (the backdrop) while the slot shows the intercepted route — i.e. a modal overlay.
    const slotElements: Record<string, ReactNode> = {};
    let intercepting = false;
    for (const [name, defs] of Object.entries(slots)) {
        const slotMatch = match(defs, pathname, soft);
        if (!slotMatch) continue;
        if (slotMatch.route.intercept) intercepting = true;
        slotElements[name] = (
            <ParamsContext.Provider value={slotMatch.params}>
                {renderMatched(slotMatch.route, slotMatch.params, pathname, epoch, `@${name} `)}
            </ParamsContext.Provider>
        );
    }

    const mainPath = intercepting ? previousPathname() : pathname;
    const matched = match(routes, mainPath);
    const params: RouteParams = matched?.params ?? {};

    let content: ReactNode;
    if (matched) {
        content = renderMatched(matched.route, matched.params, mainPath, epoch, '');
    } else if (notFound) {
        const NotFound = resolveNotFound(notFound);
        content = (
            <Suspense fallback={null}>
                <NotFound />
            </Suspense>
        );
    } else {
        content = <div style={{ padding: 24, fontFamily: 'system-ui' }}>404 — Not found</div>;
    }

    if (layout) {
        const Layout = resolveLayout(layout);
        content = (
            <Suspense fallback={null}>
                <Layout>{content}</Layout>
            </Suspense>
        );
    }

    // The root error boundary (global-error.tsx) sits outside the root layout, so it catches
    // errors thrown by the layout itself — the last line of defense before a blank screen.
    if (globalError) {
        content = <ErrorBoundary fallback={errorComponent(globalError)}>{content}</ErrorBoundary>;
    }

    return (
        <ParamsContext.Provider value={params}>
            <SlotContext.Provider value={slotElements}>{content}</SlotContext.Provider>
        </ParamsContext.Provider>
    );
}

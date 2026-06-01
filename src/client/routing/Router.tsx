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
import { ParamsContext } from './params-context.js';
import { navigationEpoch, settleNavigation } from '../navigation/navigation.js';
import { applyScroll } from '../navigation/scroll.js';
import type { ErrorComponentLoader, LayoutLoader, NotFoundLoader, RouteDef } from '../types.js';

/** Loads a matched route's module + loader data (suspending), then renders it with the data in context. */
function RoutePage(props: {
    route: RouteDef;
    params: RouteParams;
    dataKey: string;
    epoch: number;
}): ReactNode {
    const { Component, data } = readRouteData(props.route, props.params, props.dataKey, props.epoch);
    return <LoaderDataContext.Provider value={data}>{createElement(Component)}</LoaderDataContext.Provider>;
}

/** Matches the current location to a route and renders it, optionally wrapped in the root layout. */
export function Router(props: {
    routes: RouteDef[];
    layout?: LayoutLoader;
    notFound?: NotFoundLoader;
    globalError?: ErrorComponentLoader;
}): ReactNode {
    const { routes, layout = null, notFound = null, globalError = null } = props;
    const pathname = useLocation();

    // After each navigation commits, apply the planned scroll (top / restore / #hash) and mark the
    // navigation settled. A layout effect runs before paint, so the scroll lands without a flash.
    useLayoutEffect(() => {
        applyScroll();
        settleNavigation();
    });

    let matched: RouteDef | undefined;
    let params: RouteParams = {};
    for (const route of routes) {
        const result = matchRoute(route.pattern, pathname);
        if (result) {
            matched = route;
            params = result;
            break;
        }
    }

    let content: ReactNode;
    if (matched) {
        const fallback: ReactNode = matched.loading
            ? createElement(Suspense, { fallback: null }, createElement(loadingComponent(matched.loading)))
            : null;
        const search = typeof window === 'undefined' ? '' : window.location.search;
        const dataKey = loaderKey(pathname, search);
        // Navigation runs in a transition (smooth — the old page stays during load). A route with a
        // `loading.tsx` opts into an immediate loading state: keying its Suspense boundary per URL
        // makes React show the fallback even inside the transition. Routes without one keep a stable
        // boundary, so the transition holds the previous page instead of flashing a blank fallback.
        content = (
            <Suspense
                key={matched.loading ? dataKey : undefined}
                fallback={fallback}>
                <RoutePage
                    route={matched}
                    params={params}
                    dataKey={dataKey}
                    epoch={navigationEpoch()}
                />
            </Suspense>
        );
        // Wrap in templates, deepest first so the shallowest ends up outermost. Templates sit
        // inside the layouts and are keyed by pathname so they re-mount on every navigation
        // (resetting their state), unlike layouts which persist across navigations.
        const templates = matched.templates ?? [];
        for (let i = templates.length - 1; i >= 0; i--) {
            const Template = nestedLayout(templates[i]);
            content = (
                <Suspense
                    key={`${pathname}:${String(i)}`}
                    fallback={null}>
                    <Template>{content}</Template>
                </Suspense>
            );
        }
        // Wrap in nested layouts, deepest first so the shallowest ends up outermost.
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
            content = (
                <ErrorBoundary fallback={errorComponent(matched.errorComponent)}>
                    {content}
                </ErrorBoundary>
            );
        }
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

    return <ParamsContext.Provider value={params}>{content}</ParamsContext.Provider>;
}

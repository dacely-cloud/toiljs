import { Suspense, useEffect, type ReactNode } from 'react';

import { useLocation } from './hooks.js';
import { nestedLayout, pageComponent, resolveLayout, resolveNotFound } from './lazy.js';
import { matchRoute, type RouteParams } from './match.js';
import { ParamsContext } from './params-context.js';
import { settleNavigation } from './navigation.js';
import { applyScroll } from './scroll.js';
import type { LayoutLoader, NotFoundLoader, RouteDef } from './types.js';

/** Matches the current location to a route and renders it, optionally wrapped in the root layout. */
export function Router(props: {
    routes: RouteDef[];
    layout?: LayoutLoader;
    notFound?: NotFoundLoader;
}): ReactNode {
    const { routes, layout = null, notFound = null } = props;
    const pathname = useLocation();

    // After each navigation commits, apply the planned scroll (top / restore / #hash) and mark the
    // navigation settled (clears the pending state).
    useEffect(() => {
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
        const Page = pageComponent(matched);
        content = (
            <Suspense fallback={null}>
                <Page />
            </Suspense>
        );
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

    return <ParamsContext.Provider value={params}>{content}</ParamsContext.Provider>;
}

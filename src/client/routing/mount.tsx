import { createRoot, hydrateRoot } from 'react-dom/client';

import { DevToolbar } from '../dev/devtools.js';
import { DevErrorBoundary, DevErrorOverlay, initDevErrorOverlay } from '../dev/error-overlay.js';
import { initNavigation } from '../navigation/navigation.js';
import { startPrefetcher } from '../navigation/prefetch.js';
import { hydrateLoaderData } from './loader.js';
import { matchRoute } from './match.js';
import { Router } from './Router.js';
import type { ErrorComponentLoader, LayoutLoader, NotFoundLoader, RouteDef } from '../types.js';

/** An edge-SSR document carries a `<* id="__toil_ssr">` marker baked into the
 * template; its presence flips `mount` to `hydrateRoot`. */
function isSsrDocument(): boolean {
    return typeof document !== 'undefined' && document.getElementById('__toil_ssr') !== null;
}

/** Seed the loader cache from the server's `#__toil_state` JSON so the first
 * client render uses the same data the server stamped (clean hydration). */
function seedSsrHydration(routes: RouteDef[]): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const el = document.getElementById('__toil_state');
    if (!el || !el.textContent) return;
    let state: { data?: unknown };
    try {
        state = JSON.parse(el.textContent) as { data?: unknown };
    } catch {
        return;
    }
    const { pathname, search } = window.location;
    for (const route of routes) {
        const params = matchRoute(route.pattern, pathname);
        if (params) {
            hydrateLoaderData(route, params, pathname, search, state.data);
            return;
        }
    }
}

/**
 * Mounts the toil client app into `#root` and starts idle link prefetching. Called by the
 * compiler-generated `.toil/entry.tsx`.
 */
export function mount(
    routes: RouteDef[],
    layout: LayoutLoader = null,
    notFound: NotFoundLoader = null,
    globalError: ErrorComponentLoader = null,
    slots: Record<string, RouteDef[]> = {},
): void {
    const el = document.getElementById('root');
    if (!el) throw new Error('toil: #root element not found');
    initNavigation();
    const app = (
        <Router
            routes={routes}
            layout={layout}
            notFound={notFound}
            globalError={globalError}
            slots={slots}
        />
    );
    // In dev, wrap the app in the error overlay + dev toolbar so uncaught errors surface and dev info
    // is available. The guard is the literal `import.meta.env.DEV` (not `isDevMode()`) so the whole
    // branch, and the dev-only imports, are dead-code-eliminated and tree-shaken from production.
    if ((import.meta as unknown as { env: { DEV: boolean } }).env.DEV) {
        initDevErrorOverlay();
        createRoot(el).render(
            <>
                <DevErrorBoundary>{app}</DevErrorBoundary>
                <DevErrorOverlay />
                <DevToolbar
                    routes={routes}
                    slots={slots}
                />
            </>,
        );
    } else if (isSsrDocument()) {
        // Edge-SSR: the document already holds server-rendered markup. Seed the
        // loader cache from `#__toil_state` and hydrate in place (reuse the DOM)
        // rather than client-rendering from scratch.
        seedSsrHydration(routes);
        hydrateRoot(el, app);
    } else {
        createRoot(el).render(app);
    }
    // Prefetch across the main tree and every slot tree (one prefetcher owns the whole table).
    startPrefetcher([...routes, ...Object.values(slots).flat()]);
}

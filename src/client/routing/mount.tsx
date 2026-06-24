import { createRoot, hydrateRoot } from 'react-dom/client';

import { DevToolbar } from '../dev/devtools.js';
import { DevErrorBoundary, DevErrorOverlay, initDevErrorOverlay } from '../dev/error-overlay.js';
import { initNavigation } from '../navigation/navigation.js';
import { startPrefetcher } from '../navigation/prefetch.js';
import { Router } from './Router.js';
import type { ErrorComponentLoader, LayoutLoader, NotFoundLoader, RouteDef } from '../types.js';

/** An edge-SSR document carries a `<* id="__toil_ssr">` marker baked into the
 * template; its presence means the server rendered real first-paint HTML into
 * `#root`, so `mount` hydrates it in place rather than client-rendering. */
function isSsrDocument(): boolean {
    return typeof document !== 'undefined' && document.getElementById('__toil_ssr') !== null;
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
        // Dev tools (error overlay + toolbar) render into their OWN body-level
        // container, never inside `#root`, so `#root` holds only the app markup.
        // That lets an SSR document hydrate cleanly (the server only rendered the
        // app into `#root`), and is harmless for a plain client-rendered page.
        const devEl = document.createElement('div');
        devEl.id = '__toil_dev';
        document.body.appendChild(devEl);
        createRoot(devEl).render(
            <>
                <DevErrorOverlay />
                <DevToolbar
                    routes={routes}
                    slots={slots}
                />
            </>,
        );
        const tree = <DevErrorBoundary>{app}</DevErrorBoundary>;
        if (isSsrDocument()) {
            // Edge-SSR: hydrate the server-rendered markup in place.
            hydrateRoot(el, tree);
            // The dev shell carried render-blocking `<link data-toil-dev-ssr>` so this
            // server-rendered first paint was already styled (no FOUC). Vite has since injected the
            // same CSS via the entry's imports (HMR-managed), so drop the static links to avoid stale
            // duplicates surviving a hot edit.
            document.querySelectorAll('link[data-toil-dev-ssr]').forEach((n) => {
                n.remove();
            });
        } else {
            createRoot(el).render(tree);
        }
    } else if (isSsrDocument()) {
        // Edge-SSR: the document already holds server-rendered markup; hydrate it
        // (reuse the DOM) rather than client-rendering from scratch.
        hydrateRoot(el, app);
    } else {
        createRoot(el).render(app);
    }
    // Prefetch across the main tree and every slot tree (one prefetcher owns the whole table).
    startPrefetcher([...routes, ...Object.values(slots).flat()]);
}

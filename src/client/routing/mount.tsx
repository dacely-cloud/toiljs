import { createRoot } from 'react-dom/client';

import { DevToolbar } from '../dev/devtools.js';
import {
    DevErrorBoundary,
    DevErrorOverlay,
    initDevErrorOverlay,
} from '../dev/error-overlay.js';
import { initNavigation } from '../navigation/navigation.js';
import { startPrefetcher } from '../navigation/prefetch.js';
import { Router } from './Router.js';
import type { ErrorComponentLoader, LayoutLoader, NotFoundLoader, RouteDef } from '../types.js';

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
                <DevToolbar routes={routes} slots={slots} />
            </>,
        );
    } else {
        createRoot(el).render(app);
    }
    // Prefetch across the main tree and every slot tree (one prefetcher owns the whole table).
    startPrefetcher([...routes, ...Object.values(slots).flat()]);
}

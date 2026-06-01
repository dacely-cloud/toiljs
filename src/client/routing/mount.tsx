import { createRoot } from 'react-dom/client';

import {
    DevErrorBoundary,
    DevErrorOverlay,
    initDevErrorOverlay,
    isDevMode,
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
        />
    );
    // In dev, wrap the app in the error overlay so uncaught render/async errors surface on screen
    // (not a blank page). In production it's omitted entirely.
    if (isDevMode()) {
        initDevErrorOverlay();
        createRoot(el).render(
            <>
                <DevErrorBoundary>{app}</DevErrorBoundary>
                <DevErrorOverlay />
            </>,
        );
    } else {
        createRoot(el).render(app);
    }
    startPrefetcher(routes);
}

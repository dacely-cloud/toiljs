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

/** Injects the route fade-in keyframes once (a no-op if already present); honors reduced-motion. */
function injectFadeStyles(): void {
    if (typeof document === 'undefined' || document.getElementById('toil-fade-style')) return;
    const style = document.createElement('style');
    style.id = 'toil-fade-style';
    style.textContent =
        '@keyframes toil-fade-in{from{opacity:0}to{opacity:1}}' +
        '@media (prefers-reduced-motion:reduce){.toil-fade{animation:none!important}}';
    document.head.appendChild(style);
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
    injectFadeStyles();
    const app = (
        <Router
            routes={routes}
            layout={layout}
            notFound={notFound}
            globalError={globalError}
            slots={slots}
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
    // Prefetch across the main tree and every slot tree (one prefetcher owns the whole table).
    startPrefetcher([...routes, ...Object.values(slots).flat()]);
}

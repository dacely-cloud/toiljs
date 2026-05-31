import { createRoot } from 'react-dom/client';

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
    createRoot(el).render(
        <Router
            routes={routes}
            layout={layout}
            notFound={notFound}
            globalError={globalError}
        />,
    );
    startPrefetcher(routes);
}

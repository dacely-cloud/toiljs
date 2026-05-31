import { createRoot } from 'react-dom/client';

import { initNavigation } from './navigation.js';
import { startPrefetcher } from './prefetch.js';
import { Router } from './Router.js';
import type { LayoutLoader, NotFoundLoader, RouteDef } from './types.js';

/**
 * Mounts the toil client app into `#root` and starts idle link prefetching. Called by the
 * compiler-generated `.toil/entry.tsx`.
 */
export function mount(
    routes: RouteDef[],
    layout: LayoutLoader = null,
    notFound: NotFoundLoader = null,
): void {
    const el = document.getElementById('root');
    if (!el) throw new Error('toil: #root element not found');
    initNavigation();
    createRoot(el).render(
        <Router
            routes={routes}
            layout={layout}
            notFound={notFound}
        />,
    );
    startPrefetcher(routes);
}

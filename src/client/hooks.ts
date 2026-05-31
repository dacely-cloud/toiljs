/**
 * Router hooks exposed to user route components: read the current params, navigate imperatively,
 * and subscribe to the current pathname.
 */
import { startTransition, useContext, useEffect, useState } from 'react';

import type { RouteParams } from './match.js';
import { navigate, subscribeLocation } from './navigation.js';
import { ParamsContext } from './params-context.js';

/** Current dynamic route params, e.g. `{ id }` inside `/blog/:id`. */
export function useParams(): RouteParams {
    return useContext(ParamsContext);
}

/** Returns the imperative `navigate(href, { replace })` function. */
export function useNavigate(): typeof navigate {
    return navigate;
}

/**
 * Subscribes to and returns the current `location.pathname`. The update runs in a transition so
 * React keeps the current page on screen while the next route's lazy chunk loads, instead of
 * flashing the Suspense fallback.
 */
export function useLocation(): string {
    const [pathname, setPathname] = useState<string>(() => window.location.pathname);
    useEffect(
        () =>
            subscribeLocation(() => {
                startTransition(() => {
                    setPathname(window.location.pathname);
                });
            }),
        [],
    );
    return pathname;
}

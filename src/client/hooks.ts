/**
 * Router hooks exposed to user route components: read the current params, navigate imperatively,
 * and subscribe to the current pathname.
 */
import { useContext, useEffect, useState } from 'react';

import type { RouteParams } from './match.js';
import { navigate, subscribeLocation } from './navigation.js';
import { ParamsContext } from './params-context.js';

/** Current dynamic route params, e.g. `{ id }` inside `/blog/:id`. */
export function useParams(): RouteParams {
    return useContext(ParamsContext);
}

/** Returns the imperative `navigate(href)` function. */
export function useNavigate(): (href: string) => void {
    return navigate;
}

/** Subscribes to and returns the current `location.pathname`, re-rendering on navigation. */
export function useLocation(): string {
    const [pathname, setPathname] = useState<string>(() => window.location.pathname);
    useEffect(
        () =>
            subscribeLocation(() => {
                setPathname(window.location.pathname);
            }),
        [],
    );
    return pathname;
}

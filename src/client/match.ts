/** Extracted dynamic route parameters, e.g. `{ id: "42" }` for `/blog/:id` matching `/blog/42`. */
export type RouteParams = Record<string, string>;

/**
 * Matches a route pattern against a pathname, returning extracted params or `null` if no match.
 * Pure and runtime-agnostic (used by the router and unit-tested directly).
 *   matchRoute('/', '/')                  -> {}
 *   matchRoute('/blog/:id', '/blog/42')   -> { id: '42' }
 *   matchRoute('/docs/*slug', '/docs/a/b') -> { slug: 'a/b' }   (catch-all, 1+ segments)
 *   matchRoute('/docs/**slug', '/docs')   -> { slug: '' }       (optional catch-all, 0+ segments)
 *   matchRoute('/about', '/x')            -> null
 */
export function matchRoute(pattern: string, pathname: string): RouteParams | null {
    const patternSegs = pattern.split('/').filter(Boolean);
    const pathSegs = pathname.split('/').filter(Boolean);

    const params: RouteParams = {};
    for (let i = 0; i < patternSegs.length; i++) {
        const p = patternSegs[i];

        // Optional catch-all (`**slug`): captures the rest of the path, matching zero or more segments.
        if (p.startsWith('**')) {
            params[p.slice(2)] = pathSegs
                .slice(i)
                .map((s) => decodeURIComponent(s))
                .join('/');
            return params;
        }

        if (p.startsWith('*')) {
            const rest = pathSegs.slice(i);
            if (rest.length === 0) return null;
            params[p.slice(1)] = rest.map((s) => decodeURIComponent(s)).join('/');
            return params;
        }

        if (i >= pathSegs.length) return null;
        const value = pathSegs[i];
        if (p.startsWith(':')) {
            params[p.slice(1)] = decodeURIComponent(value);
        } else if (p !== value) {
            return null;
        }
    }

    return patternSegs.length === pathSegs.length ? params : null;
}

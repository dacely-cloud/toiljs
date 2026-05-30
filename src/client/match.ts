/** Extracted dynamic route parameters, e.g. `{ id: "42" }` for `/blog/:id` matching `/blog/42`. */
export type RouteParams = Record<string, string>;

/**
 * Matches a route pattern against a pathname, returning extracted params or `null` if no match.
 * Pure and runtime-agnostic (used by the router and unit-tested directly).
 *   matchRoute('/', '/')            -> {}
 *   matchRoute('/blog/:id', '/blog/42') -> { id: '42' }
 *   matchRoute('/about', '/x')      -> null
 */
export function matchRoute(pattern: string, pathname: string): RouteParams | null {
    const patternSegs = pattern.split('/').filter(Boolean);
    const pathSegs = pathname.split('/').filter(Boolean);
    if (patternSegs.length !== pathSegs.length) return null;

    const params: RouteParams = {};
    for (let i = 0; i < patternSegs.length; i++) {
        const p = patternSegs[i];
        const value = pathSegs[i];
        if (p.startsWith(':')) {
            params[p.slice(1)] = decodeURIComponent(value);
        } else if (p !== value) {
            return null;
        }
    }
    return params;
}

import fs from 'node:fs';
import path from 'node:path';

/** A discovered route: the source file and the URL pattern it serves. */
export interface ScannedRoute {
    readonly file: string;
    readonly pattern: string;
}

const ROUTE_EXT = /\.(tsx|jsx)$/;

/**
 * Derives a route pattern from a route file path (relative to the routes dir).
 *   index.tsx          -> /
 *   about.tsx          -> /about
 *   blog/index.tsx     -> /blog
 *   blog/[id].tsx      -> /blog/:id
 *   docs/[...slug].tsx -> /docs/*slug   (catch-all)
 */
export function filePathToRoute(relPath: string): string {
    const withoutExt = relPath.replace(/\\/g, '/').replace(ROUTE_EXT, '');
    const segments = withoutExt.split('/').filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (segment === 'index' && i === segments.length - 1) continue;
        out.push(
            segment
                .replace(/^\[\.\.\.(.+)\]$/, '*$1') // catch-all [...slug] -> *slug
                .replace(/^\[(.+)\]$/, ':$1'), // dynamic [id] -> :id
        );
    }
    return '/' + out.join('/');
}

/**
 * Ranks a pattern so more specific routes match first: static segments beat dynamic (`:x`),
 * which beat catch-all (`*x`); deeper routes beat shallower ones.
 */
function specificity(pattern: string): number {
    const segments = pattern.split('/').filter(Boolean);
    let score = segments.length * 10;
    for (const segment of segments) {
        if (segment.startsWith('*')) score -= 5; // catch-all: lowest
        else if (!segment.startsWith(':')) score += 5; // static: highest
    }
    return score;
}

/** Recursively scans `routesDir` for `.tsx`/`.jsx` files, returning routes sorted by specificity. */
export function scanRoutes(routesDir: string): ScannedRoute[] {
    if (!fs.existsSync(routesDir)) return [];
    const found: ScannedRoute[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (ROUTE_EXT.test(entry.name)) {
                found.push({
                    file: full,
                    pattern: filePathToRoute(path.relative(routesDir, full)),
                });
            }
        }
    };
    walk(routesDir);
    found.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
    return found;
}

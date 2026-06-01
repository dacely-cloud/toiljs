import fs from 'node:fs';
import path from 'node:path';

/** A discovered route: the source file and the URL pattern it serves. */
export interface ScannedRoute {
    readonly file: string;
    readonly pattern: string;
    /** Named parallel slot this route belongs to (from an `@slot` dir), or `undefined` for the main tree. */
    readonly slot?: string;
}

const ROUTE_EXT = /\.(tsx|jsx)$/;
/** Special files that live alongside routes but are not themselves pages. */
const SPECIAL_FILE = /^(layout|template|loading|error|global-error|404|not-found)\.(tsx|jsx)$/;

/**
 * Derives a route pattern from a route file path (relative to the routes dir).
 *   index.tsx          -> /
 *   about.tsx          -> /about
 *   blog/index.tsx     -> /blog
 *   blog/[id].tsx        -> /blog/:id
 *   docs/[...slug].tsx   -> /docs/*slug    (catch-all)
 *   docs/[[...slug]].tsx -> /docs/**slug   (optional catch-all)
 *   (marketing)/about.tsx -> /about        (route group: parens add no URL segment)
 *   @modal/photo/[id].tsx -> /photo/:id     (parallel slot: `@slot` adds no URL segment)
 */
export function filePathToRoute(relPath: string): string {
    const withoutExt = relPath.replace(/\\/g, '/').replace(ROUTE_EXT, '');
    const segments = withoutExt.split('/').filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (/^\(.+\)$/.test(segment)) continue;
        if (/^@/.test(segment)) continue; // parallel-slot marker — contributes no URL segment
        if (segment === 'index' && i === segments.length - 1) continue;
        out.push(
            segment
                .replace(/^\[\[\.\.\.(.+)\]\]$/, '**$1')
                .replace(/^\[\.\.\.(.+)\]$/, '*$1')
                .replace(/^\[(.+)\]$/, ':$1'),
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
        if (segment.startsWith('*')) score -= 5;
        else if (!segment.startsWith(':')) score += 5;
    }
    return score;
}

/** The parallel-slot name for a route path (the first `@slot` segment), or `undefined`. */
function slotOf(relPath: string): string | undefined {
    for (const segment of relPath.replace(/\\/g, '/').split('/')) {
        const match = /^@(.+)$/.exec(segment);
        if (match) return match[1];
    }
    return undefined;
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
            } else if (ROUTE_EXT.test(entry.name) && !SPECIAL_FILE.test(entry.name)) {
                const rel = path.relative(routesDir, full);
                found.push({ file: full, pattern: filePathToRoute(rel), slot: slotOf(rel) });
            }
        }
    };
    walk(routesDir);
    found.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
    return found;
}

import fs from 'node:fs';
import path from 'node:path';

/** A discovered route: the source file and the URL pattern it serves. */
export interface ScannedRoute {
    readonly file: string;
    readonly pattern: string;
    /** Named parallel slot this route belongs to (from an `@slot` dir), or `undefined` for the main tree. */
    readonly slot?: string;
    /** True for an intercepting route (`(.)`/`(..)`/`(...)`) — matched only on soft navigation. */
    readonly intercept?: boolean;
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
/** Converts a path segment's dynamic brackets to URL params (`[id]`→`:id`, `[...x]`→`*x`, `[[...x]]`→`**x`). */
function toUrlSegment(segment: string): string {
    return segment
        .replace(/^\[\[\.\.\.(.+)\]\]$/, '**$1')
        .replace(/^\[\.\.\.(.+)\]$/, '*$1')
        .replace(/^\[(.+)\]$/, ':$1');
}

/** Interception markers: `(.)` same level, `(..)` up one, `(...)` from the routes root. */
const INTERCEPT_RE = /^\((\.{1,3})\)(.+)$/;

export function filePathToRoute(relPath: string): string {
    const withoutExt = relPath.replace(/\\/g, '/').replace(ROUTE_EXT, '');
    const segments = withoutExt.split('/').filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (/^\(.+\)$/.test(segment)) continue;
        if (/^@/.test(segment)) continue; // parallel-slot marker — contributes no URL segment
        if (segment === 'index' && i === segments.length - 1) continue;
        out.push(toUrlSegment(segment));
    }
    return '/' + out.join('/');
}

/**
 * The URL an intercepting route targets, or `null` if the path has no `(.)`/`(..)`/`(...)` marker.
 * The marker resolves the target relative to the route's position (ignoring `@slot`/`(group)`
 * segments): `(.)` keeps the current level, `(..)` drops one, `(...)` resets to the root.
 *   @modal/(.)photo/[id].tsx     -> /photo/:id
 *   feed/@modal/(..)photo/[id].tsx -> /photo/:id
 */
export function interceptTarget(relPath: string): string | null {
    const segments = relPath.replace(/\\/g, '/').replace(ROUTE_EXT, '').split('/').filter(Boolean);
    const out: string[] = [];
    let marked = false;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (/^@/.test(segment)) continue;
        const marker = INTERCEPT_RE.exec(segment);
        if (marker) {
            marked = true;
            const dots = marker[1].length;
            if (dots === 2) out.pop(); // (..) up one level
            else if (dots === 3) out.length = 0; // (...) from the routes root
            out.push(toUrlSegment(marker[2]));
            continue;
        }
        if (/^\(.+\)$/.test(segment)) continue;
        if (segment === 'index' && i === segments.length - 1) continue;
        out.push(toUrlSegment(segment));
    }
    return marked ? '/' + out.join('/') : null;
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
                const target = interceptTarget(rel);
                found.push({
                    file: full,
                    pattern: target ?? filePathToRoute(rel),
                    slot: slotOf(rel),
                    intercept: target !== null,
                });
            }
        }
    };
    walk(routesDir);
    found.sort((a, b) => specificity(b.pattern) - specificity(a.pattern));
    return found;
}

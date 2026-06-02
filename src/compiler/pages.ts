import { createRequire } from 'node:module';
import path from 'node:path';

import type * as TS from 'typescript';

import { extractStaticExports } from './prerender.js';
import type { ScannedRoute } from './routes.js';

type Ts = typeof TS;

/**
 * A page in the build-time search index: its URL pattern, whether it's dynamic, and the
 * statically-extracted `metadata` literal (the searchable subset; dynamic `generateMetadata` and
 * computed values can't be known at build, so they're absent). Serialized into the generated
 * `routes` module and registered client-side for {@link searchPages}.
 */
export interface PageIndexEntry {
    readonly path: string;
    readonly dynamic: boolean;
    readonly metadata: Record<string, unknown>;
}

/**
 * Loads the project's TypeScript synchronously (so {@link buildPageIndex} can run inside the sync
 * `generate()`), or `null` if it isn't installed — in which case pages are indexed by path only.
 */
function loadTypeScriptSync(root: string): Ts | null {
    try {
        const require = createRequire(path.join(root, 'package.json'));
        const mod = require('typescript') as { default?: Ts } & Ts;
        return mod.default ?? mod;
    } catch {
        return null;
    }
}

/** True when a route pattern has dynamic (`:param` / `*catch-all`) segments. */
function isDynamic(pattern: string): boolean {
    return /[:*]/.test(pattern);
}

/**
 * Builds the searchable page index from the scanned routes: every main-tree page (slots and
 * intercepting routes are excluded — they don't own a distinct URL) paired with its statically
 * extracted `metadata`. A route may also `export const searchHints` (a static `title`/`description`/
 * `keywords` object) to feed the index even when its real metadata is dynamic (`generateMetadata`);
 * hints are merged over the static `metadata`, winning ties. Reads each route file once.
 */
export function buildPageIndex(root: string, routes: readonly ScannedRoute[]): PageIndexEntry[] {
    const ts = loadTypeScriptSync(root);
    const seen = new Set<string>();
    const pages: PageIndexEntry[] = [];
    for (const route of routes) {
        if (route.slot !== undefined || route.intercept) continue;
        if (seen.has(route.pattern)) continue;
        seen.add(route.pattern);
        const exports = ts ? extractStaticExports(ts, route.file, ['metadata', 'searchHints']) : {};
        const metadata = { ...exports.metadata, ...exports.searchHints };
        pages.push({ path: route.pattern, dynamic: isDynamic(route.pattern), metadata });
    }
    // Stable order (by path) so the generated module is deterministic across runs.
    pages.sort((a, b) => a.path.localeCompare(b.path));
    return pages;
}

/** Serializes the page index to the `export const pages` literal embedded in the routes module. */
export function pagesModuleSource(pages: readonly PageIndexEntry[]): string {
    const body = pages.map((p) => `  ${JSON.stringify(p)},`).join('\n');
    return `export const pages: PageMeta[] = [\n${body}\n];\n`;
}

/**
 * React binding for the page-metadata {@link searchPages search}. Gives a route component reactive,
 * memoized search results plus a `goTo` helper that navigates straight to a matched page, a drop-in
 * for a site-wide "jump to page" / command-palette style search box.
 */
import { useMemo } from 'react';

import { navigate, type NavigateOptions } from '../navigation/navigation.js';
import type { Href } from '../types.js';
import {
    getPages,
    pagePath,
    searchPages,
    type PageMeta,
    type PageSearchOptions,
    type PageSearchResult,
} from './search.js';

/** What {@link usePageSearch} returns. */
export interface PageSearch {
    /** Ranked matches for the current query (best first); empty when the query is blank. */
    readonly results: readonly PageSearchResult[];
    /** The full registered page index (handy for rendering an "all pages" listing). */
    readonly pages: readonly PageMeta[];
    /**
     * Navigates to a result / page / raw path. A dynamic (`:param`) page can't be navigated to
     * as-is, so passing one (or its result) is a no-op unless you pass a concrete path string with
     * the params already filled in.
     */
    goTo(target: string | PageMeta | PageSearchResult, options?: NavigateOptions): void;
}

/** Whether a path can be navigated to directly (no unfilled dynamic segments). */
function isNavigable(path: string): boolean {
    return !/[:*]/.test(path);
}

/**
 * Searches the project's pages by `query` and returns ranked {@link PageSearchResult}s, recomputed
 * only when the query or options change. Use the returned `goTo` to redirect to a match:
 *
 * ```tsx
 * const { results, goTo } = usePageSearch(query);
 * return results.map((r) => (
 *   <button key={r.page.path} onClick={() => { goTo(r); }}>{r.page.metadata.title ?? r.page.path}</button>
 * ));
 * ```
 */
export function usePageSearch(query: string, options: PageSearchOptions = {}): PageSearch {
    const { limit, includeDynamic, fields } = options;
    const fieldsKey = fields?.join(',');
    const results = useMemo(
        () => searchPages(query, { limit, includeDynamic, fields }),
        // `fields` is compared by content (fieldsKey) so a fresh array literal each render is fine.
        [query, limit, includeDynamic, fieldsKey],
    );

    return useMemo<PageSearch>(
        () => ({
            results,
            pages: getPages(),
            goTo(target, navOptions) {
                const path = pagePath(target);
                if (typeof target !== 'string' && !isNavigable(path)) return;
                navigate(path as Href, navOptions);
            },
        }),
        [results],
    );
}

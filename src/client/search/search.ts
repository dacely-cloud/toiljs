/**
 * Site-wide page search over route {@link Metadata}. The compiler bakes a static index of every
 * page's title/description/keywords/OpenGraph (extracted from each route's `export const metadata`)
 * into the generated bundle and registers it with {@link registerPages} at startup. User code then
 * queries it with {@link searchPages} (pure, framework-agnostic) or the {@link usePageSearch} hook,
 * getting back ranked pages with their `path` ready to feed to `Link` / `navigate`.
 *
 * Only statically-analyzable metadata is indexed: a route's `generateMetadata` (dynamic, per-request)
 * and computed values can't be known at build time. A dynamic route can still be made discoverable
 * by exporting static {@link SearchHints} (`export const searchHints = { title, keywords, … }`),
 * which the compiler merges over the route's static `metadata` when building the index.
 */
import type { Metadata } from '../head/metadata.js';

/**
 * Static search hints a route can `export const searchHints` to seed the search index, useful when
 * the route's real `<head>` is produced by a dynamic `generateMetadata` (so nothing else is
 * statically indexable). Merged over the route's static `metadata`, winning ties.
 */
export interface SearchHints {
    /** Indexed as the page title (highest-weighted field). */
    readonly title?: string;
    /** Indexed as the page description. */
    readonly description?: string;
    /** Indexed keywords (string or array). */
    readonly keywords?: string | readonly string[];
}

/** A searchable page: its route pattern plus the statically-known metadata baked at build time. */
export interface PageMeta {
    /** Route URL pattern, e.g. `'/'`, `'/about'`, `'/blog/:id'`. */
    readonly path: string;
    /** Whether `path` has dynamic (`:param` / `*catch-all`) segments, not navigable without params. */
    readonly dynamic: boolean;
    /** The page's statically-extracted metadata (empty object when the route declares none). */
    readonly metadata: Metadata;
}

/** A metadata field that {@link searchPages} can match against. */
export type SearchField = 'title' | 'description' | 'keywords' | 'path' | 'openGraph';

/** Options for {@link searchPages}. */
export interface PageSearchOptions {
    /** Cap the number of results returned (after ranking). Default: no cap. */
    readonly limit?: number;
    /** Include dynamic (`:param` / `*`) routes, which can't be navigated to as-is. Default: `false`. */
    readonly includeDynamic?: boolean;
    /** Restrict matching to these fields. Default: every searchable field. */
    readonly fields?: readonly SearchField[];
}

/** A page that matched a query, with its relevance {@link score} and the fields that matched. */
export interface PageSearchResult {
    readonly page: PageMeta;
    /** Relevance score (higher = better); always `> 0` for a returned result. */
    readonly score: number;
    /** The metadata fields that contributed to the match, e.g. `['title', 'keywords']`. */
    readonly matches: readonly SearchField[];
}

/** Relative weight of each field, title is the strongest signal, OpenGraph the weakest. */
const FIELD_WEIGHT: Record<SearchField, number> = {
    title: 10,
    path: 6,
    keywords: 5,
    description: 3,
    openGraph: 2,
};

const ALL_FIELDS: readonly SearchField[] = [
    'title',
    'description',
    'keywords',
    'path',
    'openGraph',
];

/** The live page index, populated by {@link registerPages} from the compiler-generated bundle. */
let registry: readonly PageMeta[] = [];

/**
 * Registers the project's page index. Called once at startup by the generated `globals` module
 * (`Toil.registerPages(pages)`); replaces any previous registration. Rarely called by user code,
 * but exposed for tests and advanced setups that build their own index.
 */
export function registerPages(pages: readonly PageMeta[]): void {
    registry = pages;
}

/** The registered page index (every page, including dynamic ones). Empty before registration. */
export function getPages(): readonly PageMeta[] {
    return registry;
}

/** Normalizes a search target (a result, a page, or a raw path) to its route path string. */
export function pagePath(target: string | PageMeta | PageSearchResult): string {
    if (typeof target === 'string') return target;
    return 'page' in target ? target.page.path : target.path;
}

/** Joins a page's keyword list (string or array) into one searchable string. */
function keywordsText(keywords: Metadata['keywords']): string {
    if (keywords === undefined) return '';
    return typeof keywords === 'string' ? keywords : keywords.join(' ');
}

/** The searchable text for one field of a page (empty string when the field is unset). */
function fieldText(page: PageMeta, field: SearchField): string {
    const m = page.metadata;
    switch (field) {
        case 'title':
            return m.title ?? '';
        case 'description':
            return m.description ?? '';
        case 'keywords':
            return keywordsText(m.keywords);
        case 'path':
            // Make slugs word-searchable: '/get-started' → 'get started', '/blog/:id' → 'blog id'.
            return page.path.replace(/[/:*\-_]+/g, ' ').trim();
        case 'openGraph': {
            const og = m.openGraph;
            if (!og) return '';
            return [og.title, og.description, og.siteName, og.type].filter(Boolean).join(' ');
        }
    }
}

/** Whether the character before `index` is a word boundary (start of string or non-alphanumeric). */
function isWordStart(text: string, index: number): boolean {
    return index === 0 || !/[a-z0-9]/i.test(text[index - 1]);
}

/**
 * Scores a single field against one query term, returning `0` for no match. Substring matches count;
 * a whole-field exact match, a prefix match, and a word-boundary match each rank progressively higher.
 */
function scoreTerm(text: string, term: string, weight: number): number {
    const index = text.indexOf(term);
    if (index === -1) return 0;
    if (text === term) return weight * 3; // the field IS the term
    if (index === 0) return weight * 1.6; // prefix of the field
    if (isWordStart(text, index)) return weight * 1.2; // start of a word within the field
    return weight; // mid-word substring
}

/**
 * Searches the registered page index for `query`, returning pages ranked by relevance (best first).
 * Matching is case-insensitive; the query is split on whitespace and every term must match somewhere
 * (AND semantics) for a page to be included. An empty query returns no results. Dynamic routes are
 * excluded unless {@link PageSearchOptions.includeDynamic} is set, since they need params to navigate.
 */
export function searchPages(query: string, options: PageSearchOptions = {}): PageSearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const fields = options.fields ?? ALL_FIELDS;

    const results: PageSearchResult[] = [];
    for (const page of registry) {
        if (page.dynamic && !options.includeDynamic) continue;

        const texts = fields.map((field) => ({
            field,
            text: fieldText(page, field).toLowerCase(),
        }));
        const matched = new Set<SearchField>();
        let score = 0;
        // AND semantics: every term must hit at least one field, or the page is dropped.
        const allTermsMatch = terms.every((term) => {
            let termScore = 0;
            for (const { field, text } of texts) {
                if (!text) continue;
                const s = scoreTerm(text, term, FIELD_WEIGHT[field]);
                if (s > 0) {
                    termScore += s;
                    matched.add(field);
                }
            }
            score += termScore;
            return termScore > 0;
        });
        if (allTermsMatch && score > 0) {
            results.push({ page, score, matches: [...matched] });
        }
    }

    // Best score first; ties broken by path for a stable, deterministic order.
    results.sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path));
    return options.limit !== undefined ? results.slice(0, options.limit) : results;
}

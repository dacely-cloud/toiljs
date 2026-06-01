import { matchRoute } from '../routing/match.js';
import type { RouteDef } from '../types.js';

declare global {
    interface Navigator {
        /** Non-standard but widely shipped; used to skip prefetch on data-saver / slow links. */
        readonly connection?: {
            readonly saveData?: boolean;
            readonly effectiveType?: string;
        };
    }
}

let routeTable: RouteDef[] = [];
const warmed = new WeakSet<RouteDef>();
let io: IntersectionObserver | null = null;
let mo: MutationObserver | null = null;

/** Resolves a same-origin `href` to a registered route, or `null` for external/unknown targets. */
function routeForHref(href: string): RouteDef | null {
    let url: URL;
    try {
        url = new URL(href, window.location.href);
    } catch {
        return null;
    }
    if (url.origin !== window.location.origin) return null;
    for (const route of routeTable) {
        if (matchRoute(route.pattern, url.pathname)) return route;
    }
    return null;
}

/**
 * Warms a route's lazy chunk by triggering its loader once. Best-effort: each route loads at most
 * once, and a failed load is forgotten (so the real navigation can retry and surface the error).
 */
function warm(route: RouteDef): void {
    if (warmed.has(route)) return;
    warmed.add(route);
    void route.load().catch(() => {
        warmed.delete(route);
    });
}

/**
 * Prefetches the route chunk for an internal `href` so a later navigation resolves instantly.
 * No-op for external, unknown, or already-prefetched targets, safe to call from anywhere,
 * including before an imperative {@link navigate} (e.g. `prefetch('/dashboard')` on hover/intent).
 */
export function prefetch(href: string): void {
    const route = routeForHref(href);
    if (route) warm(route);
}

/** Anchors to skip even when internal: new-tab, downloads, or an explicit `data-no-prefetch` opt-out. */
function isPrefetchable(a: HTMLAnchorElement): boolean {
    if (a.target && a.target !== '_self') return false;
    if (a.hasAttribute('download')) return false;
    if (a.dataset.noPrefetch !== undefined) return false;
    return true;
}

/** Observes an anchor for viewport entry if it points at a known internal route. */
function observeAnchor(a: HTMLAnchorElement): void {
    if (!io || !isPrefetchable(a) || !routeForHref(a.href)) return;
    io.observe(a);
}

/** Finds and observes every `<a href>` under `root`. */
function scan(root: ParentNode): void {
    root.querySelectorAll('a[href]').forEach((el) => {
        if (el instanceof HTMLAnchorElement) observeAnchor(el);
    });
}

/** Skip prefetching on data-saver mode or 2g-class connections, where bandwidth is precious. */
function shouldSkipForConnection(): boolean {
    const c = navigator.connection;
    if (!c) return false;
    return c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g';
}

/**
 * Starts idle-time prefetching of internal links. As each `<a>` pointing at a known route scrolls
 * into view (or near it, 200px margin) its chunk is warmed once; links added later by client
 * navigation are picked up via a MutationObserver. Called by {@link mount}; runs once per app.
 */
export function startPrefetcher(routes: RouteDef[]): void {
    routeTable = routes;
    if (
        typeof window === 'undefined' ||
        typeof IntersectionObserver === 'undefined' ||
        typeof MutationObserver === 'undefined' ||
        io
    ) {
        return;
    }
    if (shouldSkipForConnection()) return;

    io = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const a = entry.target;
                if (a instanceof HTMLAnchorElement) {
                    io?.unobserve(a);
                    prefetch(a.href);
                }
            }
        },
        { rootMargin: '200px' },
    );

    mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node instanceof HTMLAnchorElement) observeAnchor(node);
                else if (node instanceof Element) scan(node);
            }
        }
    });

    const begin = (): void => {
        scan(document);
        mo?.observe(document.body, { childList: true, subtree: true });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(begin);
    else setTimeout(begin, 200);
}

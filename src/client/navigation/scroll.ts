/**
 * Manual scroll management for client navigation: scroll to top on push navigations, restore the
 * saved position on back/forward, and honor in-page `#hash` targets. Positions are keyed by
 * history entry; {@link applyScroll} runs once after the navigation commits.
 */
const positions = new Map<string, number>();

interface ScrollPlan {
    readonly restore: number | null;
    readonly hash: string;
    readonly toTop: boolean;
}
let plan: ScrollPlan | null = null;

/** Switches off the browser's automatic scroll restoration so the router can manage it. */
export function enableManualScrollRestoration(): void {
    if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
        window.history.scrollRestoration = 'manual';
    }
}

/** Saves the current scroll position for a history key (called before leaving an entry). */
export function rememberScroll(key: string): void {
    positions.set(key, window.scrollY);
}

/** Plans what {@link applyScroll} should do after the next navigation commits. */
export function planScroll(opts: { restoreKey?: string; hash: string; toTop: boolean }): void {
    plan = {
        restore: opts.restoreKey !== undefined ? (positions.get(opts.restoreKey) ?? 0) : null,
        hash: opts.hash,
        toTop: opts.toTop,
    };
}

/** Applies the pending scroll plan once: hash target, else restored position, else top. */
export function applyScroll(): void {
    const current = plan;
    plan = null;
    if (!current) return;
    if (current.hash) {
        const el = document.getElementById(decodeURIComponent(current.hash.slice(1)));
        if (el) {
            el.scrollIntoView();
            return;
        }
    }
    if (current.restore !== null) {
        window.scrollTo(0, current.restore);
        return;
    }
    if (current.toTop) window.scrollTo(0, 0);
}

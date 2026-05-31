/**
 * History-based navigation core. Owns the location subscribers, the single `popstate` handler, and
 * the per-entry history keys used for scroll restoration. Consumed by `useLocation` (to re-render),
 * `Link` / `navigate` (to change location), and `Router` (which calls `applyScroll` after commit).
 */
import {
    enableManualScrollRestoration,
    planScroll,
    rememberScroll,
} from './scroll.js';

const listeners = new Set<() => void>();
let popstateBound = false;

interface ToilHistoryState {
    __toilKey?: string;
}
let keyCounter = 0;
let currentKey = 'initial';
function nextKey(): string {
    keyCounter += 1;
    return `t${String(keyCounter)}`;
}

/** Notifies every subscriber that the location may have changed. */
function notify(): void {
    for (const listener of listeners) listener();
}

// Navigation-pending tracking: a navigation is "pending" from when it starts until the new route
// commits. Drives useNavigationPending() (e.g. a top loading bar).
let startedTick = 0;
let committedTick = 0;
const pendingListeners = new Set<() => void>();
function emitPending(): void {
    for (const listener of pendingListeners) listener();
}
function beginNavigation(): void {
    startedTick += 1;
    emitPending();
}

/** Marks the in-flight navigation as committed. Called by `Router` after each commit. */
export function settleNavigation(): void {
    if (committedTick !== startedTick) {
        committedTick = startedTick;
        emitPending();
    }
}

/** Whether a navigation is in flight (started but not yet committed). */
export function isNavigationPending(): boolean {
    return startedTick !== committedTick;
}

/** Subscribes to navigation-pending changes; returns an unsubscribe function. */
export function subscribePending(listener: () => void): () => void {
    pendingListeners.add(listener);
    return () => {
        pendingListeners.delete(listener);
    };
}

/** Options for {@link navigate}. */
export interface NavigateOptions {
    /** Replace the current history entry instead of pushing a new one. Default `false`. */
    readonly replace?: boolean;
    /** Scroll to the top of the page after navigating. Default `true`. */
    readonly scroll?: boolean;
}

/** Initializes manual scroll restoration and the initial history key. Called once by `mount`. */
export function initNavigation(): void {
    enableManualScrollRestoration();
    const state = window.history.state as ToilHistoryState | null;
    if (state?.__toilKey) {
        currentKey = state.__toilKey;
    } else {
        currentKey = nextKey();
        window.history.replaceState({ ...state, __toilKey: currentKey }, '');
    }
}

/** Navigates to `href` without a full page reload (history push/replace + subscriber re-render). */
export function navigate(href: string, options?: NavigateOptions): void {
    beginNavigation();
    rememberScroll(currentKey);
    let hash = '';
    try {
        hash = new URL(href, window.location.href).hash;
    } catch {
        hash = '';
    }
    if (options?.replace) {
        window.history.replaceState({ __toilKey: currentKey }, '', href);
    } else {
        currentKey = nextKey();
        window.history.pushState({ __toilKey: currentKey }, '', href);
    }
    planScroll({ hash, toTop: options?.scroll !== false });
    notify();
}

/** Goes back one entry in history (fires `popstate`, which notifies subscribers). */
export function back(): void {
    window.history.back();
}

/** Goes forward one entry in history. */
export function forward(): void {
    window.history.forward();
}

/** Re-renders the current route without changing the URL (there is no server data to refetch). */
export function refresh(): void {
    notify();
}

/** Handles browser back/forward: restores the saved scroll for the target entry, then re-renders. */
function handlePopState(event: PopStateEvent): void {
    beginNavigation();
    rememberScroll(currentKey);
    const state = event.state as ToilHistoryState | null;
    currentKey = state?.__toilKey ?? 'initial';
    planScroll({ restoreKey: currentKey, hash: window.location.hash, toTop: false });
    notify();
}

/**
 * Subscribes `listener` to location changes and returns an unsubscribe function. Browser
 * back/forward is wired once, on the first subscription, via a shared `popstate` handler.
 */
export function subscribeLocation(listener: () => void): () => void {
    if (!popstateBound) {
        window.addEventListener('popstate', handlePopState);
        popstateBound = true;
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

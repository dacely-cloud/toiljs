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
import type { Href } from '../types.js';

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

// Soft vs hard navigation, for intercepting routes. The initial page load (and any full refresh) is
// "hard"; client navigations (`navigate` / back / forward) are "soft". `previousPath` is the path we
// were on before the latest soft navigation, the route the main view keeps showing while an
// intercepting route fills a slot (the modal overlay).
let softNav = false;
let currentPath = typeof window === 'undefined' ? '/' : window.location.pathname;
let previousPath = currentPath;

/** Records a transition to the live location; `soft` is false only for the initial load. */
function recordTransition(soft: boolean): void {
    previousPath = currentPath;
    currentPath = typeof window === 'undefined' ? '/' : window.location.pathname;
    softNav = soft;
}

/** Whether the current location was reached by a client navigation (not an initial load / refresh). */
export function isSoftNavigation(): boolean {
    return softNav;
}

/** The path the app was on before the latest navigation (what the main view keeps during an intercept). */
export function previousPathname(): string {
    return previousPath;
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

/** Monotonic id incremented on each navigation, used to key/revalidate per-navigation route data. */
export function navigationEpoch(): number {
    return startedTick;
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
export function navigate(href: Href, options?: NavigateOptions): void {
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
    recordTransition(true);
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
    recordTransition(true);
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

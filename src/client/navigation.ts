/**
 * History-based navigation core. Owns the set of location subscribers and the single `popstate`
 * handler, so navigation state lives in one place independent of React. Consumed by the
 * `useLocation` hook (to re-render) and the `Link` component / `navigate` (to change location).
 */

/** Location-change subscribers, notified after every pushState navigation or browser back/forward. */
const listeners = new Set<() => void>();
let popstateBound = false;

/** Notifies every subscriber that the location may have changed. */
function notify(): void {
    for (const listener of listeners) listener();
}

/** Options for {@link navigate}. */
export interface NavigateOptions {
    /** Replace the current history entry instead of pushing a new one. Default `false`. */
    readonly replace?: boolean;
}

/** Navigates to `href` without a full page reload (history push/replace + subscriber re-render). */
export function navigate(href: string, options?: NavigateOptions): void {
    if (options?.replace) {
        window.history.replaceState({}, '', href);
    } else {
        window.history.pushState({}, '', href);
    }
    notify();
}

/**
 * Subscribes `listener` to location changes and returns an unsubscribe function. Browser
 * back/forward is wired once, on the first subscription, via a shared `popstate` handler.
 */
export function subscribeLocation(listener: () => void): () => void {
    if (!popstateBound) {
        window.addEventListener('popstate', notify);
        popstateBound = true;
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

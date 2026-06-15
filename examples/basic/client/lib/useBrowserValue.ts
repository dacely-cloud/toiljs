import { useCallback, useRef, useSyncExternalStore } from 'react';

/**
 * Read a browser-only value (e.g. `document.cookie`) hydration-safely.
 *
 * Returns `server` during SSR and the first client paint, then the live `read()`
 * value after mount, so the server and client markup always match. Call the
 * returned `refresh()` after an action that changed the underlying source (a
 * login, a Set-Cookie response) to re-read on demand.
 *
 * This is the `useSyncExternalStore` form of "sync a browser value into state on
 * mount", which avoids the synchronous `setState`-in-`useEffect` pattern the React
 * Compiler lint rules flag (`react-hooks/set-state-in-effect`).
 */
export function useBrowserValue<T>(read: () => T, server: T): readonly [T, () => void] {
    const subscribers = useRef(new Set<() => void>());
    // Cache the snapshot so `getSnapshot` is referentially stable between refreshes
    // (a fresh object each call would loop `useSyncExternalStore`).
    const snapshot = useRef<{ live: boolean; value: T }>({ live: false, value: server });

    const subscribe = useCallback((onStoreChange: () => void) => {
        subscribers.current.add(onStoreChange);
        return () => {
            subscribers.current.delete(onStoreChange);
        };
    }, []);

    const getSnapshot = useCallback(() => {
        if (!snapshot.current.live) snapshot.current = { live: true, value: read() };
        return snapshot.current.value;
    }, [read]);

    const refresh = useCallback(() => {
        snapshot.current = { live: true, value: read() };
        subscribers.current.forEach((onStoreChange) => onStoreChange());
    }, [read]);

    const value = useSyncExternalStore(subscribe, getSnapshot, () => server);
    return [value, refresh];
}

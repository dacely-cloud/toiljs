import { useEffect, type ReactNode } from 'react';

/**
 * When a {@link Script} is injected, relative to the app becoming interactive:
 * - `afterInteractive` (default) — on mount, once the app is running. Good for analytics, widgets.
 * - `lazyOnload` — deferred until the browser is idle (after `window.load`). For low-priority scripts.
 * - `beforeInteractive` — as early as possible. In a client-only SPA there is no SSR, so this still
 *   runs after hydration, but synchronously on first mount with high fetch priority.
 */
export type ScriptStrategy = 'beforeInteractive' | 'afterInteractive' | 'lazyOnload';

/** Props for {@link Script}. Provide either `src` (external) or inline `children` (script body). */
export interface ScriptProps {
    /** URL of an external script. Omit when providing an inline script body via `children`. */
    src?: string;
    /** When to load the script. Default `'afterInteractive'`. */
    strategy?: ScriptStrategy;
    /** Stable identity for dedup (required for inline scripts; defaults to `src` for external ones). */
    id?: string;
    /** `type` attribute (e.g. `'module'`, `'application/json'`). */
    type?: string;
    /** Fired once the script has loaded (external) or been inserted (inline). */
    onLoad?: () => void;
    /** Fired after load, and on every later mount once the script is already loaded. */
    onReady?: () => void;
    /** Fired if an external script fails to load. */
    onError?: (error: unknown) => void;
    /** Inline script body. Mutually exclusive with `src`. */
    children?: string;
}

type LoadState = 'loading' | 'ready';
/** Module-level registry so a given script is injected/executed at most once across the app. */
const registry = new Map<string, LoadState>();

function inject(props: ScriptProps, key: string): void {
    const { src, type, onLoad, onReady, onError, children } = props;
    const el = document.createElement('script');
    el.dataset.toilScript = key;
    if (type !== undefined) el.type = type;

    if (src !== undefined) {
        el.src = src;
        el.async = true;
        el.addEventListener('load', () => {
            registry.set(key, 'ready');
            onLoad?.();
            onReady?.();
        });
        el.addEventListener('error', (event) => {
            registry.delete(key); // allow a later remount to retry
            onError?.(event);
        });
        document.head.appendChild(el);
    } else {
        el.textContent = children ?? '';
        document.head.appendChild(el);
        registry.set(key, 'ready');
        onLoad?.();
        onReady?.();
    }
}

/**
 * Loads an external or inline `<script>` with a load `strategy`, deduplicated across the app so the
 * same script never executes twice. Renders nothing.
 */
export function Script(props: ScriptProps): ReactNode {
    const { src, id, strategy = 'afterInteractive', onReady } = props;
    const key = id ?? src;

    useEffect(() => {
        if (key === undefined) {
            // No id and no src: nothing to dedup or load (an inline script needs at least an id).
            return;
        }

        const state = registry.get(key);
        if (state === 'ready') {
            onReady?.();
            return;
        }
        if (state === 'loading') {
            return; // another instance is already injecting it
        }

        registry.set(key, 'loading');
        const run = (): void => {
            inject(props, key);
        };

        if (strategy === 'lazyOnload') {
            if (document.readyState === 'complete') {
                const idle = window.requestIdleCallback?.bind(window);
                if (idle) idle(run);
                else setTimeout(run, 0);
            } else {
                window.addEventListener('load', run, { once: true });
            }
            return () => {
                window.removeEventListener('load', run);
            };
        }

        // beforeInteractive + afterInteractive: inject now (on mount).
        run();
        // Intentionally keyed on identity only: inject once per script key; later prop changes
        // (handlers, body) are read at inject time and must not re-run/re-inject the script.
    }, [key, strategy]);

    return null;
}

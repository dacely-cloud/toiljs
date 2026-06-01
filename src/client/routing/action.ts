/**
 * Mutations (writes) — the counterpart to loaders (reads). A loader fetches data on navigation;
 * an action performs a write (save, delete, a server/WASM call) on demand, then revalidates the
 * affected loader data so the UI reflects the change. `useAction` tracks pending/error/result state;
 * `<Form>` is sugar over it for the form case.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { invalidateLoaderData } from './loader.js';
import { refresh } from '../navigation/navigation.js';
import type { Href } from '../types.js';

/**
 * Which loader data to refetch after an action succeeds:
 * - `true` (default) — the current route.
 * - an `Href` (or array) — those specific routes.
 * - `false` — nothing.
 */
export type RevalidateTarget = boolean | Href | readonly Href[];

/** Options for {@link useAction}. */
export interface UseActionOptions<TData> {
    /** Loader data to revalidate after success. Default `true` (the current route). */
    readonly revalidate?: RevalidateTarget;
    /** Called after a successful run, with the action's return value. */
    readonly onSuccess?: (data: TData) => void;
    /** Called when the action throws. */
    readonly onError?: (error: unknown) => void;
}

/** Live state of an action. */
export interface ActionState<TData> {
    /** True while a run is in flight. */
    readonly pending: boolean;
    /** The error from the last failed run, or `undefined`. */
    readonly error: unknown;
    /** The value returned by the last successful run, or `undefined`. */
    readonly data: TData | undefined;
}

/** Handle returned by {@link useAction}: current state plus `run` / `reset`. */
export interface ActionHandle<TInput, TData> extends ActionState<TData> {
    /**
     * Run the action. Resolves to the result on success, or `undefined` if it threw (the error is
     * captured in `error` instead of rejecting, so a fire-and-forget `onClick` can't leak an
     * unhandled rejection).
     */
    run: (input: TInput) => Promise<TData | undefined>;
    /** Reset back to idle (clears `pending` / `error` / `data`). */
    reset: () => void;
}

/** Refetches loader data per a {@link RevalidateTarget}, then re-renders once. */
function applyRevalidate(target: RevalidateTarget | undefined): void {
    if (target === false) return;
    if (target === undefined || target === true) {
        invalidateLoaderData();
    } else {
        const hrefs = typeof target === 'string' ? [target] : target;
        for (const href of hrefs) invalidateLoaderData(href);
    }
    refresh();
}

/**
 * Runs a mutation with pending/error/result tracking, revalidating loader data on success. Example:
 *
 * ```ts
 * const save = useAction((title: string) => api.save(title), { revalidate: true });
 * <button disabled={save.pending} onClick={() => void save.run(title)}>Save</button>
 * ```
 */
export function useAction<TInput = void, TData = unknown>(
    fn: (input: TInput) => TData | Promise<TData>,
    options: UseActionOptions<TData> = {},
): ActionHandle<TInput, TData> {
    const [state, setState] = useState<ActionState<TData>>({
        pending: false,
        error: undefined,
        data: undefined,
    });

    // Hold the latest fn/options so `run` keeps a stable identity across renders.
    const latest = useRef({ fn, options });
    latest.current = { fn, options };
    const runId = useRef(0);
    const mounted = useRef(true);
    useEffect(
        () => () => {
            mounted.current = false;
        },
        [],
    );

    const run = useCallback(async (input: TInput): Promise<TData | undefined> => {
        const id = ++runId.current;
        setState((s) => ({ ...s, pending: true, error: undefined }));
        try {
            const data = await latest.current.fn(input);
            // Ignore a stale run that a newer one (or unmount) has superseded.
            if (mounted.current && id === runId.current) {
                setState({ pending: false, error: undefined, data });
            }
            applyRevalidate(latest.current.options.revalidate);
            latest.current.options.onSuccess?.(data);
            return data;
        } catch (error) {
            if (mounted.current && id === runId.current) {
                setState({ pending: false, error, data: undefined });
            }
            latest.current.options.onError?.(error);
            return undefined;
        }
    }, []);

    const reset = useCallback(() => {
        runId.current += 1;
        setState({ pending: false, error: undefined, data: undefined });
    }, []);

    return { ...state, run, reset };
}

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { Revalidate } from '../../src/client/routing/loader';
import {
    clearLoaderData,
    invalidateLoaderData,
    type LoaderData,
    loaderKey,
    readRouteData,
} from '../../src/client/routing/loader';
import type { RouteDef } from '../../src/client/types';

/** Reads route data, awaiting the suspending promise once if it's pending. */
async function read(route: RouteDef, key: string, epoch: number): Promise<unknown> {
    try {
        return readRouteData(route, {}, key, epoch).data;
    } catch (thrown) {
        if (thrown instanceof Promise) {
            await thrown;
            return readRouteData(route, {}, key, epoch).data;
        }
        throw thrown;
    }
}

/** A route whose `load()` count tells us how many times the loader actually ran. */
function makeRoute(revalidate?: Revalidate): { route: RouteDef; loads: () => number } {
    let loads = 0;
    const route: RouteDef = {
        pattern: '/x',
        load: () => {
            loads += 1;
            return Promise.resolve({
                default: () => null,
                loader: () => ({ n: loads }),
                revalidate,
            });
        },
    };
    return { route, loads: () => loads };
}

beforeEach(() => {
    clearLoaderData();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('loader caching', () => {
    it('reuses cached data on re-read within the same navigation (loader runs once)', async () => {
        const { route, loads } = makeRoute();
        const key = loaderKey('/x', '');
        await read(route, key, 1);
        await read(route, key, 1);
        expect(loads()).toBe(1);
    });

    it('a route with no loader stays cached across navigations (never re-suspends)', async () => {
        let loads = 0;
        const route: RouteDef = {
            pattern: '/p',
            load: () => {
                loads += 1;
                return Promise.resolve({ default: () => null });
            },
        };
        const key = loaderKey('/p', '');
        await read(route, key, 1);
        await read(route, key, 2);
        await read(route, key, 3);
        expect(loads).toBe(1);
    });

    it('refetches on a new navigation under the default policy', async () => {
        const { route, loads } = makeRoute();
        const key = loaderKey('/x', '');
        await read(route, key, 1);
        await read(route, key, 2);
        expect(loads()).toBe(2);
    });

    it('revalidate=false caches across navigations', async () => {
        const { route, loads } = makeRoute(false);
        const key = loaderKey('/x', '');
        await read(route, key, 1);
        await read(route, key, 2);
        expect(loads()).toBe(1);
    });

    it('numeric revalidate caches until the staleTime elapses', async () => {
        vi.useFakeTimers();
        const { route, loads } = makeRoute(1); // 1 second
        const key = loaderKey('/x', '');
        await read(route, key, 1);
        await read(route, key, 2); // still fresh
        expect(loads()).toBe(1);
        vi.advanceTimersByTime(1500); // now stale
        await read(route, key, 3);
        expect(loads()).toBe(2);
    });

    it('invalidateLoaderData(href) forces a refetch of that route', async () => {
        const { route, loads } = makeRoute(false);
        const key = loaderKey('/x', '');
        await read(route, key, 1);
        invalidateLoaderData('/x');
        await read(route, key, 1);
        expect(loads()).toBe(2);
    });
});

describe('useLoaderData type inference', () => {
    it('LoaderData<typeof loader> resolves to the loader return type', () => {
        const loader = async () => Promise.resolve({ a: 1, b: 'x' as string | null });
        expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<{ a: number; b: string | null }>();
        // An explicit type still passes straight through.
        expectTypeOf<LoaderData<{ id: number }>>().toEqualTypeOf<{ id: number }>();
    });
});

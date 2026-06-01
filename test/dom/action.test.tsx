// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAction } from '../../src/client/routing/action';
import { Form } from '../../src/client/components/Form';
import { clearLoaderData, loaderKey, readRouteData } from '../../src/client/routing/loader';
import type { RouteDef } from '../../src/client/types';

afterEach(cleanup);
beforeEach(() => {
    clearLoaderData();
});

describe('useAction', () => {
    it('goes idle → pending → success and returns the result', async () => {
        const onSuccess = vi.fn();
        const { result } = renderHook(() =>
            useAction((n: number) => Promise.resolve(n * 2), { revalidate: false, onSuccess }),
        );
        expect(result.current.pending).toBe(false);

        let returned: number | undefined;
        await act(async () => {
            returned = await result.current.run(3);
        });
        expect(returned).toBe(6);
        expect(result.current.data).toBe(6);
        expect(result.current.error).toBeUndefined();
        expect(onSuccess).toHaveBeenCalledWith(6);
    });

    it('captures errors instead of rejecting, and calls onError', async () => {
        const onError = vi.fn();
        const { result } = renderHook(() =>
            useAction(
                () => {
                    throw new Error('boom');
                },
                { revalidate: false, onError },
            ),
        );

        let returned: unknown = 'sentinel';
        await act(async () => {
            returned = await result.current.run();
        });
        expect(returned).toBeUndefined();
        expect((result.current.error as Error).message).toBe('boom');
        expect(onError).toHaveBeenCalledOnce();
    });

    it('reset() returns to idle', async () => {
        const { result } = renderHook(() => useAction(() => 'x', { revalidate: false }));
        await act(async () => {
            await result.current.run();
        });
        expect(result.current.data).toBe('x');
        act(() => {
            result.current.reset();
        });
        expect(result.current.data).toBeUndefined();
        expect(result.current.pending).toBe(false);
    });

    it('revalidate: true invalidates cached loader data', async () => {
        const route: RouteDef = {
            pattern: '/x',
            load: () => Promise.resolve({ default: () => null, loader: () => ({ n: 1 }), revalidate: false }),
        };
        const key = loaderKey('/x', '');
        // Seed the cache (suspends once, then resolves).
        try {
            readRouteData(route, {}, key, 1);
        } catch (thrown) {
            await (thrown as Promise<void>);
        }
        // Cached now: a re-read returns synchronously (no throw).
        expect(() => readRouteData(route, {}, key, 1)).not.toThrow();

        const { result } = renderHook(() => useAction(() => 'done', { revalidate: true }));
        await act(async () => {
            await result.current.run();
        });
        // Cache was cleared → reading again suspends (throws a promise).
        expect(() => readRouteData(route, {}, key, 1)).toThrow();
    });
});

describe('Form', () => {
    it('submits FormData (no reload) and exposes pending state', async () => {
        let received: FormDataEntryValue | null = null;
        const action = vi.fn((data: FormData) => {
            received = data.get('title');
        });
        const { getByText, getByPlaceholderText } = render(
            <Form action={action} revalidate={false}>
                {({ pending }) => (
                    <>
                        <input name="title" placeholder="t" />
                        <button type="submit">{pending ? 'Saving…' : 'Save'}</button>
                    </>
                )}
            </Form>,
        );
        fireEvent.change(getByPlaceholderText('t'), { target: { value: 'Hello' } });
        fireEvent.click(getByText('Save'));
        await waitFor(() => {
            expect(action).toHaveBeenCalledOnce();
        });
        expect(received).toBe('Hello');
    });

    it('resets fields after success when resetOnSuccess is set', async () => {
        const { getByText, getByPlaceholderText } = render(
            <Form action={() => undefined} revalidate={false} resetOnSuccess>
                <input name="title" placeholder="t" defaultValue="" />
                <button type="submit">Save</button>
            </Form>,
        );
        const input = getByPlaceholderText('t') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'typed' } });
        expect(input.value).toBe('typed');
        fireEvent.click(getByText('Save'));
        await waitFor(() => {
            expect(input.value).toBe('');
        });
    });
});

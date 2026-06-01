// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import { Slot } from '../../src/client/components/Slot';
import { Router } from '../../src/client/routing/Router';
import { SlotContext } from '../../src/client/routing/slot-context';
import type { RouteDef } from '../../src/client/types';

afterEach(cleanup);
beforeEach(() => {
    window.history.replaceState({}, '', '/');
});

describe('Slot', () => {
    it('renders the named slot element from context, or the fallback', () => {
        const { getByText, queryByText } = render(
            <SlotContext.Provider value={{ modal: <span>MODAL</span> }}>
                <Slot name="modal" />
                <Slot name="missing" fallback={<span>FB</span>} />
            </SlotContext.Provider>,
        );
        expect(getByText('MODAL')).toBeTruthy();
        expect(getByText('FB')).toBeTruthy();
        expect(queryByText('missing')).toBeNull();
    });
});

describe('Router parallel slots', () => {
    const routes: RouteDef[] = [
        { pattern: '/', load: () => Promise.resolve({ default: () => <main>PAGE</main> }) },
    ];
    // A layout that renders the page plus the "modal" slot.
    const layout = () =>
        Promise.resolve({
            default: ({ children }: { children?: ReactNode }) => (
                <div>
                    {children}
                    <Slot name="modal" />
                </div>
            ),
        });
    const slots: Record<string, RouteDef[]> = {
        modal: [{ pattern: '/', load: () => Promise.resolve({ default: () => <aside>SLOT</aside> }) }],
    };

    it('renders the main route and a matching slot together', async () => {
        const { findByText } = render(<Router routes={routes} layout={layout} slots={slots} />);
        // Both the page and the parallel slot render for the same URL.
        await findByText('PAGE');
        await findByText('SLOT');
    });
});

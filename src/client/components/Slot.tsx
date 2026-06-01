import { useContext, type ReactNode } from 'react';

import { SlotContext } from '../routing/slot-context.js';

/** Props for {@link Slot}. */
export interface SlotProps {
    /** The parallel-slot name — the `@name` directory under `routes/` (without the `@`). */
    name: string;
    /** Rendered when the slot has no match for the current URL. Default `null`. */
    fallback?: ReactNode;
}

/**
 * Renders the parallel-route slot named `name` for the current URL. Place it in a layout or page to
 * show an `@name` route tree alongside the main content (e.g. a persistent sidebar, or a modal that
 * an intercepting route fills). Renders `fallback` (default nothing) when no slot route matches.
 */
export function Slot({ name, fallback = null }: SlotProps): ReactNode {
    const slots = useContext(SlotContext);
    return slots[name] ?? fallback;
}

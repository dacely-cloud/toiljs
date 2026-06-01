/**
 * Context carrying the rendered element for each parallel-route slot (`@slot`), keyed by name.
 * Provided by the Router for the current URL, consumed by {@link Slot}.
 */
import { createContext, type ReactNode } from 'react';

export const SlotContext = createContext<Record<string, ReactNode>>({});

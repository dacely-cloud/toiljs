/**
 * Public router types shared across the client runtime. Kept dependency-free (type-only React
 * imports) so any module can import them without pulling in component or DOM code.
 */
import type { ComponentType, ReactNode } from 'react';

/** A route entry produced by the compiler: a URL pattern and a lazy loader for its page component. */
export interface RouteDef {
    readonly pattern: string;
    readonly load: () => Promise<{ default: ComponentType }>;
}

/** Optional root layout loader (wraps every page). `null` when the project defines no layout. */
export type LayoutLoader =
    | (() => Promise<{ default: ComponentType<{ children?: ReactNode }> }>)
    | null;

/** Optional custom not-found (404) page loader, rendered when no route matches. */
export type NotFoundLoader = (() => Promise<{ default: ComponentType }>) | null;

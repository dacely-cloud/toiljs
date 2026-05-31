/**
 * Public router types shared across the client runtime. Kept dependency-free (type-only React
 * imports) so any module can import them without pulling in component or DOM code.
 */
import type { ComponentType, ReactNode } from 'react';

/** Lazy loader for a layout component (wraps children). */
export type LayoutComponentLoader = () => Promise<{
    default: ComponentType<{ children?: ReactNode }>;
}>;

/** Props passed to an `error.tsx` component: the thrown error and a function to retry rendering. */
export interface RouteErrorProps {
    readonly error: Error;
    readonly reset: () => void;
}

/**
 * A route entry produced by the compiler: a URL pattern, a lazy loader for its page component, and
 * the chain of nested layout loaders (shallowest → deepest, from nested `layout.tsx` files) that wrap it.
 */
export interface RouteDef {
    readonly pattern: string;
    readonly load: () => Promise<{ default: ComponentType }>;
    readonly layouts?: readonly LayoutComponentLoader[];
    /** Nearest `loading.tsx` — shown as the Suspense fallback while this route loads. */
    readonly loading?: () => Promise<{ default: ComponentType }>;
    /** Nearest `error.tsx` — rendered by an error boundary around this route. */
    readonly errorComponent?: () => Promise<{ default: ComponentType<RouteErrorProps> }>;
}

/** Optional root layout loader (wraps every page). `null` when the project defines no layout. */
export type LayoutLoader = LayoutComponentLoader | null;

/** Optional custom not-found (404) page loader, rendered when no route matches. */
export type NotFoundLoader = (() => Promise<{ default: ComponentType }>) | null;

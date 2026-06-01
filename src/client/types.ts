/**
 * Public router types shared across the client runtime. Kept dependency-free (type-only React
 * imports) so any module can import them without pulling in component or DOM code.
 */
import type { ComponentType, ReactNode } from 'react';

/**
 * Augmentation point for the project's generated route types. The compiler emits (into
 * `toil-routes.d.ts`) `declare module 'toiljs/client' { interface Register { routePath: <union> } }`,
 * which narrows {@link RoutePath} from `string` to the project's actual routes.
 */
export interface Register {}

/**
 * Union of the project's route paths — static routes as literals, dynamic/catch-all as
 * `` `…/${string}` `` templates. Falls back to `string` before the types are generated.
 */
export type RoutePath = Register extends { routePath: infer P }
    ? P extends string
        ? P
        : string
    : string;

/**
 * An href accepted by `Link` / `NavLink` / `navigate`: a known {@link RoutePath} (optionally with
 * `?query` or `#hash`), or an absolute/protocol URL (`https:`, `mailto:`, …). When routes haven't
 * been generated yet, this is just `string`.
 */
export type Href =
    | RoutePath
    | `${RoutePath}?${string}`
    | `${RoutePath}#${string}`
    | `${string}:${string}`;

/** Lazy loader for a layout component (wraps children). */
export type LayoutComponentLoader = () => Promise<{
    default: ComponentType<{ children?: ReactNode }>;
}>;

/** Props passed to an `error.tsx` / `global-error.tsx` component. */
export interface RouteErrorProps {
    readonly error: Error;
    readonly reset: () => void;
}

/** Lazy loader for an error component (`error.tsx` / `global-error.tsx`), or `null` if none. */
export type ErrorComponentLoader =
    | (() => Promise<{ default: ComponentType<RouteErrorProps> }>)
    | null;

/**
 * A route entry produced by the compiler: a URL pattern, a lazy loader for its page component, and
 * the chain of nested layout loaders (shallowest → deepest, from nested `layout.tsx` files) that wrap it.
 */
export interface RouteDef {
    readonly pattern: string;
    readonly load: () => Promise<{ default: ComponentType }>;
    readonly layouts?: readonly LayoutComponentLoader[];
    /** `template.tsx` chain (root → nested) — like layouts, but re-mounted on each navigation. */
    readonly templates?: readonly LayoutComponentLoader[];
    /** Nearest `loading.tsx` — shown as the Suspense fallback while this route loads. */
    readonly loading?: () => Promise<{ default: ComponentType }>;
    /** Nearest `error.tsx` — rendered by an error boundary around this route. */
    readonly errorComponent?: () => Promise<{ default: ComponentType<RouteErrorProps> }>;
    /** Intercepting route (`(.)`/`(..)`/`(...)`) — matched in its slot only on soft navigation. */
    readonly intercept?: boolean;
}

/** Optional root layout loader (wraps every page). `null` when the project defines no layout. */
export type LayoutLoader = LayoutComponentLoader | null;

/** Optional custom not-found (404) page loader, rendered when no route matches. */
export type NotFoundLoader = (() => Promise<{ default: ComponentType }>) | null;

import {
    createContext,
    lazy,
    Suspense,
    useContext,
    useEffect,
    useState,
    type ComponentType,
    type MouseEvent,
    type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';

import { matchRoute, type RouteParams } from './match.js';

/** A route entry produced by the compiler: a URL pattern and a lazy loader for its page component. */
export interface RouteDef {
    readonly pattern: string;
    readonly load: () => Promise<{ default: ComponentType }>;
}

/** Optional root layout loader (wraps every page). */
export type LayoutLoader = (() => Promise<{ default: ComponentType<{ children?: ReactNode }> }>) | null;

// --- client-side navigation store -------------------------------------------------------------

const listeners = new Set<() => void>();

/** Navigates to `href` without a full page reload (history pushState + re-render). */
export function navigate(href: string): void {
    window.history.pushState({}, '', href);
    for (const listener of listeners) listener();
}

const ParamsContext = createContext<RouteParams>({});

/** Current dynamic route params, e.g. `{ id }` inside `/blog/:id`. */
export function useParams(): RouteParams {
    return useContext(ParamsContext);
}

/** Returns the imperative `navigate(href)` function. */
export function useNavigate(): (href: string) => void {
    return navigate;
}

/** Subscribes to and returns the current `location.pathname`. */
export function useLocation(): string {
    const [pathname, setPathname] = useState<string>(() => window.location.pathname);
    useEffect(() => {
        const update = (): void => { setPathname(window.location.pathname); };
        listeners.add(update);
        window.addEventListener('popstate', update);
        return () => {
            listeners.delete(update);
            window.removeEventListener('popstate', update);
        };
    }, []);
    return pathname;
}

/** Client-side navigation link. Falls back to default browser behavior for modified clicks. */
export function Link(props: { href: string; className?: string; children?: ReactNode }): ReactNode {
    const { href, className, children } = props;
    const onClick = (e: MouseEvent): void => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
    };
    return (
        <a href={href} className={className} onClick={onClick}>
            {children}
        </a>
    );
}

// --- router -----------------------------------------------------------------------------------

const pageCache = new Map<RouteDef, ComponentType>();
function pageComponent(route: RouteDef): ComponentType {
    let component = pageCache.get(route);
    if (!component) {
        component = lazy(route.load);
        pageCache.set(route, component);
    }
    return component;
}

let layoutComponent: ComponentType<{ children?: ReactNode }> | null = null;
let layoutLoader: LayoutLoader = null;
function resolveLayout(loader: NonNullable<LayoutLoader>): ComponentType<{ children?: ReactNode }> {
    if (layoutLoader !== loader || !layoutComponent) {
        layoutComponent = lazy(loader);
        layoutLoader = loader;
    }
    return layoutComponent;
}

/** Matches the current location to a route and renders it, optionally wrapped in the root layout. */
export function Router(props: { routes: RouteDef[]; layout?: LayoutLoader }): ReactNode {
    const { routes, layout = null } = props;
    const pathname = useLocation();

    let matched: RouteDef | undefined;
    let params: RouteParams = {};
    for (const route of routes) {
        const result = matchRoute(route.pattern, pathname);
        if (result) {
            matched = route;
            params = result;
            break;
        }
    }

    let page: ReactNode;
    if (matched) {
        const Page = pageComponent(matched);
        page = (
            <Suspense fallback={null}>
                <Page />
            </Suspense>
        );
    } else {
        page = <div style={{ padding: 24, fontFamily: 'system-ui' }}>404 — Not found</div>;
    }

    const withParams = <ParamsContext.Provider value={params}>{page}</ParamsContext.Provider>;

    if (layout) {
        const Layout = resolveLayout(layout);
        return (
            <Suspense fallback={null}>
                <Layout>{withParams}</Layout>
            </Suspense>
        );
    }
    return withParams;
}

/** Mounts the toil client app into `#root`. Called by the generated `.toil/entry.tsx`. */
export function mount(routes: RouteDef[], layout: LayoutLoader = null): void {
    const el = document.getElementById('root');
    if (!el) throw new Error('toil: #root element not found');
    createRoot(el).render(<Router routes={routes} layout={layout} />);
}

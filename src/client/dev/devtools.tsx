/**
 * Development-only dev toolbar. A floating badge (bottom corner) that expands into a tabbed panel
 * showing the matched route, build/config info, captured errors, and preferences, with live feature
 * toggles, click-to-navigate, and open-in-editor. Rendered as a sibling at the app root in dev only
 * (see `mount`), behind `isDevMode()`, so the whole module is dead-code-eliminated in production.
 *
 * It stays decoupled from the Router (it computes the current match itself via `matchRoute`) so it
 * renders even when the app tree has crashed.
 */
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';

import { type DevError, getErrorLog, subscribeErrors } from './error-overlay.js';
import {
    isNavigationPending,
    navigate,
    setTransitions,
    setViewTransitions,
    subscribeLocation,
    subscribePending,
} from '../navigation/navigation.js';
import {
    clearLoaderData,
    inspectLoaderCache,
    type LoaderCacheSnapshot,
    loaderKey,
    revalidate,
    subscribeLoaderCache,
} from '../routing/loader.js';
import { matchRoute } from '../routing/match.js';
import { getPages } from '../search/search.js';
import type { Href, RouteDef } from '../types.js';

type Tab = 'route' | 'data' | 'head' | 'build' | 'errors' | 'ai' | 'prefs';

/** Base URL for the quick-doc links (the project homepage's docs section). */
const DOCS_BASE = 'https://toil.org/docs';

/** The toiljs brand mark (inlined from assets/logo.svg; unique gradient ids to avoid collisions). */
function ToilLogo({ size = 16 }: { size?: number }): ReactNode {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 500 500"
            aria-hidden="true"
            style={{ display: 'block', flex: '0 0 auto' }}>
            <defs>
                <linearGradient
                    id="toilDtA"
                    x1="43.27"
                    y1="43.27"
                    x2="467.12"
                    y2="467.12"
                    gradientUnits="userSpaceOnUse">
                    <stop
                        offset="0"
                        stopColor="#6990ff"
                    />
                    <stop
                        offset=".28"
                        stopColor="#521be0"
                    />
                    <stop
                        offset=".66"
                        stopColor="#6900f4"
                    />
                    <stop
                        offset="1"
                        stopColor="#7f00f6"
                    />
                </linearGradient>
                <linearGradient
                    id="toilDtB"
                    x1="149.99"
                    y1="355.49"
                    x2="149.99"
                    y2="0"
                    gradientUnits="userSpaceOnUse">
                    <stop
                        offset=".15"
                        stopColor="#6990ff"
                        stopOpacity=".6"
                    />
                    <stop
                        offset=".55"
                        stopColor="#531ae1"
                    />
                </linearGradient>
            </defs>
            <rect
                width="500"
                height="500"
                rx="130"
                ry="130"
                fill="url(#toilDtA)"
            />
            <path
                d="M299.98,0L0,355.49v-225.49C0,58.2,58.2,0,130,0h169.98Z"
                fill="url(#toilDtB)"
            />
            <path
                d="M106.17,111.11h285.24c9.9,0,16.7,9.96,13.09,19.18l-17.98,45.96c-2.11,5.39-7.31,8.94-13.09,8.94h-74.65c-7.76,0-14.06,6.29-14.06,14.06v214.94c0,7.76-6.29,14.06-14.06,14.06h-45.96c-7.76,0-14.06-6.29-14.06-14.06v-217.25c0-7.76-6.29-14.06-14.06-14.06h-73.66c-5.82,0-11.04-3.59-13.12-9.02l-16.76-43.64c-3.54-9.21,3.26-19.1,13.12-19.1Z"
                fill="#fff"
            />
        </svg>
    );
}

/** Anthropic / Claude brand mark. */
function ClaudeLogo({ size = 16 }: { size?: number }): ReactNode {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 92 65"
            aria-hidden="true"
            style={{ display: 'block', flex: '0 0 auto' }}>
            <path
                fill="#d97757"
                d="M66.5 0H52.4L78 65h14.1L66.5 0zM25.6 0L0 65h14.4l5.2-13.6h26.8L51.6 65H66L40.4 0H25.6zm-1.2 39.3l8.8-22.8 8.8 22.8H24.4z"
            />
        </svg>
    );
}

/** OpenAI / ChatGPT brand mark. */
function ChatGptLogo({ size = 16 }: { size?: number }): ReactNode {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            aria-hidden="true"
            style={{ display: 'block', flex: '0 0 auto' }}>
            <path
                fill="#10a37f"
                d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"
            />
        </svg>
    );
}

/** Build/config info served by the dev server at `/__toil/devinfo`. */
interface DevInfo {
    readonly toiljs: string;
    readonly vite: string;
    readonly react: string;
    readonly port: number;
    readonly enabled: boolean;
    readonly flags: Record<string, boolean>;
    readonly routes: Record<string, string>; // pattern -> absolute file
    readonly ai: boolean;
}

// --- persisted panel state (localStorage) --------------------------------------------------------

interface Prefs {
    open: boolean;
    tab: Tab;
    side: 'left' | 'right';
}
const PREFS_KEY = 'toil.devtools';
const defaultPrefs: Prefs = { open: false, tab: 'route', side: 'left' };

function loadPrefs(): Prefs {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        return raw ? { ...defaultPrefs, ...(JSON.parse(raw) as Partial<Prefs>) } : defaultPrefs;
    } catch {
        return defaultPrefs;
    }
}

// Gate on `window`, not `localStorage`: the devtools are browser-only, and merely
// touching the bare `localStorage` global under SSR/Node trips its experimental-API
// warning ("localStorage is not available because --localstorage-file ..."). In the
// browser `loadPrefs()` reads it; under SSR we keep the defaults and never touch it.
let prefs: Prefs = typeof window !== 'undefined' ? loadPrefs() : defaultPrefs;
const prefListeners = new Set<() => void>();
function setPrefs(next: Partial<Prefs>): void {
    prefs = { ...prefs, ...next };
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
        /* ignore */
    }
    for (const l of prefListeners) l();
}
function usePrefs(): Prefs {
    return useSyncExternalStore(
        (l) => {
            prefListeners.add(l);
            return () => prefListeners.delete(l);
        },
        () => prefs,
        () => defaultPrefs,
    );
}

// --- live location + nav + errors ----------------------------------------------------------------

function useCurrentUrl(): string {
    return useSyncExternalStore(
        subscribeLocation,
        () => window.location.pathname + window.location.search,
        () => '/',
    );
}
function usePending(): boolean {
    return useSyncExternalStore(subscribePending, isNavigationPending, () => false);
}
function useErrors(): readonly DevError[] {
    return useSyncExternalStore(subscribeErrors, getErrorLog, () => getErrorLog());
}
function useLoaderCache(): readonly LoaderCacheSnapshot[] {
    return useSyncExternalStore(subscribeLoaderCache, inspectLoaderCache, inspectLoaderCache);
}

/** JSON.stringify that won't throw on cyclic/odd data. */
function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

/** Reads the current document head's meta + link tags (live). */
function readHead(): {
    metas: { name: string; content: string }[];
    links: { rel: string; href: string }[];
} {
    const metas: { name: string; content: string }[] = [];
    const links: { rel: string; href: string }[] = [];
    if (typeof document === 'undefined') return { metas, links };
    document.head.querySelectorAll('meta').forEach((m) => {
        const name = m.getAttribute('name') ?? m.getAttribute('property');
        const content = m.getAttribute('content');
        if (name && content) metas.push({ name, content });
    });
    document.head.querySelectorAll('link[rel]').forEach((l) => {
        links.push({ rel: l.getAttribute('rel') ?? '', href: l.getAttribute('href') ?? '' });
    });
    return { metas, links };
}

// --- styles (injected once) ----------------------------------------------------------------------

const STYLE_ID = 'toil-devtools-style';
const CSS = `
.toil-dt{position:fixed;bottom:12px;z-index:2147483646;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e7e9f0}
.toil-dt.left{left:12px}.toil-dt.right{right:12px}
.toil-dt-badge{display:flex;align-items:center;gap:7px;background:#15151c;border:1px solid #2c2c38;border-radius:999px;padding:5px 11px 5px 8px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none}
.toil-dt-badge:hover{border-color:#3a3a48}
.toil-dt-dot{width:8px;height:8px;border-radius:50%;background:#22e3ab;box-shadow:0 0 6px #22e3ab}
.toil-dt-dot.pending{background:#f7b93e;box-shadow:0 0 6px #f7b93e;animation:toil-dt-pulse 1s infinite}
.toil-dt-dot.error{background:#ef4444;box-shadow:0 0 6px #ef4444}
@keyframes toil-dt-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.toil-dt-logo{font-weight:700;background:linear-gradient(90deg,#2563ff,#7c3aed,#22e3ab);-webkit-background-clip:text;background-clip:text;color:transparent}
.toil-dt-panel{width:380px;max-width:calc(100vw - 24px);max-height:min(70vh,560px);background:#101016;border:1px solid #2c2c38;border-radius:12px;box-shadow:0 16px 56px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden}
.toil-dt-tabs{display:flex;border-bottom:1px solid #23232e;flex:0 0 auto}
.toil-dt-tab{flex:1;padding:8px 4px;background:none;border:0;color:#8b90a4;font:inherit;cursor:pointer;border-bottom:2px solid transparent}
.toil-dt-tab.active{color:#e7e9f0;border-bottom-color:#2563ff}
.toil-dt-tab:hover{color:#c8cee0}
.toil-dt-body{padding:12px 14px;overflow:auto}
.toil-dt-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #23232e;flex:0 0 auto}
.toil-dt-x{background:none;border:0;color:#8b90a4;cursor:pointer;font:inherit;font-size:14px}
.toil-dt-row{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px solid #1b1b24}
.toil-dt-k{color:#8b90a4}
.toil-dt-v{color:#e7e9f0;text-align:right;word-break:break-all}
.toil-dt-tag{display:inline-block;padding:1px 6px;border-radius:5px;background:#23232e;color:#a8b0c8;margin:1px 3px 1px 0;font-size:11px}
.toil-dt-rt{display:flex;align-items:center;gap:6px;padding:3px 0}
.toil-dt-rt a{color:#7aa2ff;text-decoration:none;cursor:pointer}.toil-dt-rt a:hover{text-decoration:underline}
.toil-dt-rt .dyn{color:#c8cee0;cursor:default}
.toil-dt-edit{margin-left:auto;background:none;border:0;color:#5b6178;cursor:pointer;font:inherit}.toil-dt-edit:hover{color:#7aa2ff}
.toil-dt-sec{margin:0 0 6px;color:#6b7088;text-transform:uppercase;letter-spacing:.05em;font-size:10px}
.toil-dt-sw{display:flex;align-items:center;justify-content:space-between;padding:5px 0}
.toil-dt-btn{font:inherit;color:#e7e9f0;background:#23232e;border:1px solid #33333f;border-radius:6px;padding:3px 9px;cursor:pointer}
.toil-dt-btn:hover{border-color:#454556}
.toil-dt-err{padding:6px 0;border-bottom:1px solid #1b1b24}
.toil-dt-err .msg{color:#ff8a8a;word-break:break-word}
.toil-dt-empty{color:#6b7088;padding:8px 0}
.toil-dt-pre{background:#0a0a0e;border:1px solid #1b1b24;border-radius:6px;padding:8px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#c8cee0;margin:6px 0 0;font-size:11px}
.toil-dt-chk{display:flex;gap:8px;align-items:center;padding:3px 0}
.toil-dt-ok{color:#22e3ab}.toil-dt-bad{color:#ef4444}
.toil-dt-og{display:flex;gap:8px;border:1px solid #23232e;border-radius:8px;overflow:hidden;background:#0d0d13}
.toil-dt-og-img{width:72px;height:72px;object-fit:cover;flex:0 0 auto}
.toil-dt-og-body{padding:6px 8px;min-width:0}
.toil-dt-og-title{color:#e7e9f0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toil-dt-og-desc{color:#8b90a4;font-size:11px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.toil-dt-ta{width:100%;box-sizing:border-box;background:#0a0a0e;border:1px solid #23232e;border-radius:6px;color:#e7e9f0;font:inherit;padding:7px 8px;resize:vertical;min-height:54px}
.toil-dt-ta:focus{outline:none;border-color:#2563ff}
.toil-dt-ai-btns{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.toil-dt-ai-btn{display:flex;align-items:center;gap:6px;font:inherit;color:#e7e9f0;background:#23232e;border:1px solid #33333f;border-radius:6px;padding:5px 10px;cursor:pointer}
.toil-dt-ai-btn:hover{border-color:#454556}
.toil-dt-doc{display:block;color:#7aa2ff;text-decoration:none;padding:3px 0}.toil-dt-doc:hover{text-decoration:underline}
.toil-dt-pal-wrap{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.45);padding-top:14vh}
.toil-dt-pal{width:440px;max-width:calc(100vw - 24px);background:#101016;border:1px solid #2c2c38;border-radius:12px;box-shadow:0 16px 56px rgba(0,0,0,.6);overflow:hidden;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e7e9f0}
.toil-dt-pal input{width:100%;box-sizing:border-box;background:none;border:0;border-bottom:1px solid #23232e;color:#e7e9f0;font:inherit;padding:11px 14px}
.toil-dt-pal input:focus{outline:none}
.toil-dt-pal-list{max-height:340px;overflow:auto;padding:4px}
.toil-dt-pal-item{display:flex;gap:8px;align-items:center;padding:7px 10px;border-radius:6px;cursor:pointer;color:#c8cee0}
.toil-dt-pal-item.sel{background:#1c1c26;color:#e7e9f0}
.toil-dt-pal-kind{color:#6b7088;font-size:11px;margin-left:auto}
`;
function injectStyles(): void {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
}

// --- helpers -------------------------------------------------------------------------------------

function isDynamic(pattern: string): boolean {
    return /[:*]/.test(pattern);
}

function openInEditor(file: string): void {
    void fetch(`/__toil/open?file=${encodeURIComponent(file)}`).catch(() => undefined);
}

function Row({ k, children }: { k: string; children: ReactNode }): ReactNode {
    return (
        <div className="toil-dt-row">
            <span className="toil-dt-k">{k}</span>
            <span className="toil-dt-v">{children}</span>
        </div>
    );
}

// --- tabs ----------------------------------------------------------------------------------------

function RouteTab({
    routes,
    slots,
    info,
}: {
    routes: RouteDef[];
    slots: Record<string, RouteDef[]>;
    info: DevInfo | null;
}): ReactNode {
    const url = useCurrentUrl();
    const pending = usePending();
    const pathname = url.split('?')[0];
    const search = url.slice(pathname.length);

    let matched: { route: RouteDef; params: Record<string, string | string[]> } | null = null;
    for (const r of routes) {
        const params = matchRoute(r.pattern, pathname);
        if (params) {
            matched = { route: r, params };
            break;
        }
    }
    const activeSlots: string[] = [];
    for (const [name, defs] of Object.entries(slots)) {
        if (defs.some((d) => matchRoute(d.pattern, pathname))) activeSlots.push(name);
    }

    const has = (r: RouteDef): string =>
        [
            r.loading ? 'loading' : '',
            r.errorComponent ? 'error' : '',
            r.templates?.length ? 'template' : '',
            r.layouts?.length ? `${String(r.layouts.length)} layout` : '',
        ]
            .filter(Boolean)
            .join(', ') || 'none';

    return (
        <div className="toil-dt-body">
            <Row k="path">{pathname || '/'}</Row>
            <Row k="match">{matched ? matched.route.pattern : 'no match (404)'}</Row>
            {search && <Row k="query">{search}</Row>}
            {matched && Object.keys(matched.params).length > 0 && (
                <Row k="params">{JSON.stringify(matched.params)}</Row>
            )}
            {matched && <Row k="boundaries">{has(matched.route)}</Row>}
            <Row k="slots">{activeSlots.length ? activeSlots.join(', ') : 'none'}</Row>
            <Row k="navigating">{pending ? 'yes' : 'no'}</Row>

            <p
                className="toil-dt-sec"
                style={{ marginTop: 12 }}>
                Routes ({routes.length})
            </p>
            {routes.map((r) => {
                const file = info?.routes[r.pattern];
                return (
                    <div
                        className="toil-dt-rt"
                        key={r.pattern}>
                        {isDynamic(r.pattern) ? (
                            <span className="dyn">{r.pattern}</span>
                        ) : (
                            <a
                                onClick={() => {
                                    navigate(r.pattern as Href);
                                }}>
                                {r.pattern}
                            </a>
                        )}
                        {file && (
                            <button
                                className="toil-dt-edit"
                                title={`open ${file}`}
                                onClick={() => {
                                    openInEditor(file);
                                }}>
                                edit
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function DataTab(): ReactNode {
    const url = useCurrentUrl();
    const entries = useLoaderCache();
    const pathname = url.split('?')[0];
    const key = loaderKey(pathname, url.slice(pathname.length));
    const entry = entries.find((e) => e.key === key);
    return (
        <div className="toil-dt-body">
            {!entry && <p className="toil-dt-empty">No cached loader data for this route.</p>}
            {entry && (
                <>
                    <Row k="status">{entry.status}</Row>
                    <Row k="has loader">{entry.hasLoader ? 'yes' : 'no'}</Row>
                    <Row k="revalidate">
                        {entry.revalidate === false ? 'never' : `${String(entry.revalidate)}s`}
                    </Row>
                    <Row k="loaded">
                        {entry.loadedAt ? new Date(entry.loadedAt).toLocaleTimeString() : '-'}
                    </Row>
                    {entry.hasLoader ? (
                        <>
                            <div style={{ margin: '8px 0' }}>
                                <button
                                    className="toil-dt-btn"
                                    onClick={() => {
                                        revalidate();
                                    }}>
                                    Revalidate
                                </button>{' '}
                                <button
                                    className="toil-dt-btn"
                                    onClick={() => {
                                        clearLoaderData();
                                    }}>
                                    Clear cache
                                </button>
                            </div>
                            {entry.data === undefined ? (
                                <p className="toil-dt-empty">Loader returned no data.</p>
                            ) : (
                                <pre className="toil-dt-pre">{safeJson(entry.data)}</pre>
                            )}
                        </>
                    ) : (
                        <p className="toil-dt-empty">
                            This route has no loader, so there is no data to inspect.
                        </p>
                    )}
                </>
            )}
            <p
                className="toil-dt-sec"
                style={{ marginTop: 12 }}>
                Cache ({entries.length})
            </p>
            {entries.map((e) => (
                <Row
                    k={e.key}
                    key={e.key}>
                    {e.status}
                </Row>
            ))}
        </div>
    );
}

function Check({ ok, label }: { ok: boolean; label: string }): ReactNode {
    return (
        <div className="toil-dt-chk">
            <span className={ok ? 'toil-dt-ok' : 'toil-dt-bad'}>{ok ? '✓' : '✗'}</span>
            <span>{label}</span>
        </div>
    );
}

function HeadTab(): ReactNode {
    useCurrentUrl(); // re-read the DOM head on navigation
    const title = typeof document !== 'undefined' ? document.title : '';
    const { metas, links } = readHead();
    const meta = (n: string): string | undefined => metas.find((m) => m.name === n)?.content;
    const og = {
        title: meta('og:title') ?? title,
        description: meta('og:description') ?? meta('description'),
        image: meta('og:image'),
    };
    const pages = getPages();
    const described = pages.filter((p) => p.metadata.description !== undefined).length;

    return (
        <div className="toil-dt-body">
            <Row k="title">{title || '(none)'}</Row>

            <p
                className="toil-dt-sec"
                style={{ marginTop: 10 }}>
                OpenGraph preview
            </p>
            <div className="toil-dt-og">
                {og.image && (
                    <img
                        src={og.image}
                        alt=""
                        className="toil-dt-og-img"
                    />
                )}
                <div className="toil-dt-og-body">
                    <div className="toil-dt-og-title">{og.title || '(no title)'}</div>
                    <div className="toil-dt-og-desc">{og.description ?? '(no description)'}</div>
                </div>
            </div>

            <p
                className="toil-dt-sec"
                style={{ marginTop: 10 }}>
                SEO checklist
            </p>
            <Check
                ok={Boolean(title)}
                label="Has a title"
            />
            <Check
                ok={meta('description') !== undefined}
                label="Has a meta description"
            />
            <Check
                ok={og.image !== undefined}
                label="Has an og:image"
            />
            <Check
                ok={links.some((l) => l.rel === 'canonical')}
                label="Has a canonical link"
            />
            <Check
                ok={pages.length === 0 || described === pages.length}
                label={`Pages with a description: ${String(described)}/${String(pages.length)}`}
            />

            <p
                className="toil-dt-sec"
                style={{ marginTop: 10 }}>
                Meta ({metas.length})
            </p>
            {metas.map((m, i) => (
                <Row
                    k={m.name}
                    key={`${m.name}:${String(i)}`}>
                    {m.content}
                </Row>
            ))}
        </div>
    );
}

function BuildTab({ info }: { info: DevInfo | null }): ReactNode {
    return (
        <div className="toil-dt-body">
            {!info && <p className="toil-dt-empty">Loading dev info...</p>}
            {info && (
                <>
                    <Row k="toiljs">{info.toiljs}</Row>
                    <Row k="vite">{info.vite}</Row>
                    <Row k="react">{info.react}</Row>
                    <Row k="dev server">{`localhost:${String(info.port)}`}</Row>
                    <p
                        className="toil-dt-sec"
                        style={{ marginTop: 12 }}>
                        Config
                    </p>
                    {Object.entries(info.flags).map(([k, v]) => (
                        <Row
                            k={k}
                            key={k}>
                            {v ? 'on' : 'off'}
                        </Row>
                    ))}
                    <Row k="ai">{info.ai ? 'configured' : 'hand-off only'}</Row>
                </>
            )}
        </div>
    );
}

function ErrorsTab(): ReactNode {
    const errors = useErrors();
    if (errors.length === 0)
        return <p className="toil-dt-empty toil-dt-body">No errors captured.</p>;
    return (
        <div className="toil-dt-body">
            {[...errors].reverse().map((e, i) => (
                <div
                    className="toil-dt-err"
                    key={`${String(e.time)}:${String(i)}`}>
                    <div className="msg">
                        {e.error.name}: {e.error.message}
                    </div>
                    <div className="toil-dt-k">
                        {e.source}, {new Date(e.time).toLocaleTimeString()}
                    </div>
                </div>
            ))}
        </div>
    );
}

/** Builds a context string about the current page for AI hand-off / inline ask. */
function buildAiContext(): string {
    if (typeof window === 'undefined') return '';
    const where = window.location.pathname + window.location.search;
    const title = document.title;
    const desc = readHead().metas.find((m) => m.name === 'description')?.content;
    const lines = [
        'I am working on a toiljs app (React with file-based routing, backend in toilscript/WASM).',
        `Current page: ${where}`,
    ];
    if (title) lines.push(`Page title: ${title}`);
    if (desc) lines.push(`Meta description: ${desc}`);
    return lines.join('\n');
}

const DOC_LINKS: { label: string; slug: string }[] = [
    { label: 'Routing and file conventions', slug: 'routing' },
    { label: 'Loaders and data', slug: 'loaders' },
    { label: 'Metadata and SEO', slug: 'metadata' },
    { label: 'Parallel routes and slots', slug: 'slots' },
];

/** Max chars of route source to inline into the prompt (keeps the hand-off URL usable). */
const AI_CODE_MAX = 8000;

function AiTab({ info, routes }: { info: DevInfo | null; routes: RouteDef[] }): ReactNode {
    const url = useCurrentUrl(); // rebuild page context + refetch source on navigation
    const [question, setQuestion] = useState('');
    const [answer, setAnswer] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [source, setSource] = useState<{ file: string; code: string } | null>(null);
    const configured = info?.ai === true;

    // Resolve the current route's source file (pattern -> absolute path from the dev server).
    const pathname = url.split('?')[0];
    let file: string | undefined;
    for (const r of routes) {
        if (matchRoute(r.pattern, pathname)) {
            file = info?.routes[r.pattern];
            break;
        }
    }

    useEffect(() => {
        if (!file) {
            setSource(null);
            return;
        }
        let cancelled = false;
        void fetch(`/__toil/source?file=${encodeURIComponent(file)}`)
            .then((r) => (r.ok ? r.text() : null))
            .then((code) => {
                if (!cancelled) setSource(code !== null ? { file, code } : null);
            })
            .catch(() => {
                if (!cancelled) setSource(null);
            });
        return () => {
            cancelled = true;
        };
    }, [file]);

    const prompt = (): string => {
        const q = question.trim() || 'Explain this page and suggest improvements.';
        const parts = [buildAiContext()];
        if (source) {
            const code = source.code.slice(0, AI_CODE_MAX);
            const cut = source.code.length > AI_CODE_MAX ? '\n... (truncated)' : '';
            parts.push(`\nPage source (${source.file}):\n\`\`\`tsx\n${code}${cut}\n\`\`\``);
        }
        parts.push(`\nQuestion: ${q}`);
        return parts.join('\n');
    };
    const handOff = (base: string): void => {
        window.open(`${base}${encodeURIComponent(prompt())}`, '_blank', 'noopener');
    };
    const copy = (): void => {
        void navigator.clipboard.writeText(prompt()).catch(() => undefined);
    };
    const askInline = (): void => {
        setBusy(true);
        setAnswer(null);
        void fetch('/__toil/ai', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: prompt() }),
        })
            .then((r) =>
                r.ok
                    ? (r.json() as Promise<{ text?: string }>)
                    : Promise.reject(new Error(`HTTP ${String(r.status)}`)),
            )
            .then((d) => {
                setAnswer(d.text ?? '(empty response)');
            })
            .catch((e: unknown) => {
                setAnswer(`Error: ${e instanceof Error ? e.message : String(e)}`);
            })
            .finally(() => {
                setBusy(false);
            });
    };

    return (
        <div className="toil-dt-body">
            <p className="toil-dt-sec">Ask about this page</p>
            <textarea
                className="toil-dt-ta"
                placeholder="Ask about the current route, or leave blank for a summary..."
                value={question}
                onChange={(e) => {
                    setQuestion(e.target.value);
                }}
            />
            <div className="toil-dt-ai-btns">
                <button
                    className="toil-dt-ai-btn"
                    onClick={() => {
                        handOff('https://claude.ai/new?q=');
                    }}>
                    <ClaudeLogo size={14} /> Claude
                </button>
                <button
                    className="toil-dt-ai-btn"
                    onClick={() => {
                        handOff('https://chatgpt.com/?q=');
                    }}>
                    <ChatGptLogo size={14} /> ChatGPT
                </button>
                <button
                    className="toil-dt-ai-btn"
                    onClick={copy}>
                    Copy
                </button>
                {configured && (
                    <button
                        className="toil-dt-ai-btn"
                        disabled={busy}
                        onClick={askInline}>
                        {busy ? 'Asking...' : 'Ask inline'}
                    </button>
                )}
            </div>
            {source && (
                <p className="toil-dt-k">
                    Prompt includes this route&apos;s source ({source.file.split('/').pop()}).
                </p>
            )}
            {!configured && (
                <p className="toil-dt-k">
                    Inline answers are off. Set <span className="toil-dt-tag">devtools.ai</span> in
                    your config to proxy a provider; the API key stays server-side.
                </p>
            )}
            {answer !== null && <pre className="toil-dt-pre">{answer}</pre>}

            <p
                className="toil-dt-sec"
                style={{ marginTop: 12 }}>
                Quick docs
            </p>
            {DOC_LINKS.map((d) => (
                <a
                    key={d.slug}
                    className="toil-dt-doc"
                    href={`${DOCS_BASE}/${d.slug}`}
                    target="_blank"
                    rel="noreferrer">
                    {d.label}
                </a>
            ))}
        </div>
    );
}

/** A cmd/ctrl+K command palette: jump to a route or run a dev action. */
function Palette({ routes, onClose }: { routes: RouteDef[]; onClose: () => void }): ReactNode {
    const [q, setQ] = useState('');
    const [sel, setSel] = useState(0);

    const items: { label: string; kind: string; run: () => void }[] = [];
    for (const r of routes) {
        if (!isDynamic(r.pattern)) {
            items.push({
                label: r.pattern,
                kind: 'route',
                run: () => {
                    navigate(r.pattern as Href);
                    onClose();
                },
            });
        }
    }
    items.push(
        {
            label: 'Revalidate current route',
            kind: 'action',
            run: () => {
                revalidate();
                onClose();
            },
        },
        {
            label: 'Clear loader cache',
            kind: 'action',
            run: () => {
                clearLoaderData();
                onClose();
            },
        },
        {
            label: 'Ask AI about this page',
            kind: 'action',
            run: () => {
                setPrefs({ open: true, tab: 'ai' });
                onClose();
            },
        },
        {
            label: 'Open preferences',
            kind: 'action',
            run: () => {
                setPrefs({ open: true, tab: 'prefs' });
                onClose();
            },
        },
    );

    const needle = q.toLowerCase();
    const filtered = items.filter((it) => it.label.toLowerCase().includes(needle));
    const clamped = Math.min(sel, Math.max(0, filtered.length - 1));

    return (
        <div
            className="toil-dt-pal-wrap"
            onClick={onClose}>
            <div
                className="toil-dt-pal"
                onClick={(e) => {
                    e.stopPropagation();
                }}>
                <input
                    autoFocus
                    placeholder="Go to a route or run an action..."
                    value={q}
                    onChange={(e) => {
                        setQ(e.target.value);
                        setSel(0);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            setSel((s) => Math.min(s + 1, filtered.length - 1));
                        } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            setSel((s) => Math.max(s - 1, 0));
                        } else if (e.key === 'Enter') {
                            e.preventDefault();
                            filtered[clamped]?.run();
                        } else if (e.key === 'Escape') {
                            onClose();
                        }
                    }}
                />
                <div className="toil-dt-pal-list">
                    {filtered.length === 0 && <div className="toil-dt-pal-item">No matches</div>}
                    {filtered.map((it, i) => (
                        <div
                            key={`${it.kind}:${it.label}`}
                            className={`toil-dt-pal-item ${i === clamped ? 'sel' : ''}`}
                            onMouseEnter={() => {
                                setSel(i);
                            }}
                            onClick={it.run}>
                            <span>{it.label}</span>
                            <span className="toil-dt-pal-kind">{it.kind}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function PrefsTab(): ReactNode {
    const p = usePrefs();
    const [flags, setFlags] = useState({ viewTransitions: false, transitions: false });
    const toggle = (key: 'viewTransitions' | 'transitions'): void => {
        const next = !flags[key];
        setFlags((f) => ({ ...f, [key]: next }));
        if (key === 'viewTransitions') setViewTransitions(next);
        else setTransitions(next);
    };
    return (
        <div className="toil-dt-body">
            <div className="toil-dt-sw">
                <span>View transitions</span>
                <button
                    className="toil-dt-btn"
                    onClick={() => {
                        toggle('viewTransitions');
                    }}>
                    {flags.viewTransitions ? 'on' : 'off'}
                </button>
            </div>
            <div className="toil-dt-sw">
                <span>Loader transition</span>
                <button
                    className="toil-dt-btn"
                    onClick={() => {
                        toggle('transitions');
                    }}>
                    {flags.transitions ? 'on' : 'off'}
                </button>
            </div>
            <div className="toil-dt-sw">
                <span>Toolbar side</span>
                <button
                    className="toil-dt-btn"
                    onClick={() => {
                        setPrefs({ side: p.side === 'left' ? 'right' : 'left' });
                    }}>
                    {p.side}
                </button>
            </div>
        </div>
    );
}

const TABS: { id: Tab; label: string }[] = [
    { id: 'route', label: 'Route' },
    { id: 'data', label: 'Data' },
    { id: 'head', label: 'Head' },
    { id: 'build', label: 'Build' },
    { id: 'errors', label: 'Errors' },
    { id: 'ai', label: 'AI' },
    { id: 'prefs', label: 'Prefs' },
];

/** The dev toolbar. Rendered once at the app root in dev mode (see `mount`). */
export function DevToolbar({
    routes,
    slots,
}: {
    routes: RouteDef[];
    slots: Record<string, RouteDef[]>;
}): ReactNode {
    const p = usePrefs();
    const pending = usePending();
    const errors = useErrors();
    const [info, setInfo] = useState<DevInfo | null>(null);
    const [palette, setPalette] = useState(false);

    useEffect(() => {
        injectStyles();
        void fetch('/__toil/devinfo')
            .then((r) => (r.ok ? (r.json() as Promise<DevInfo>) : null))
            .then((data) => {
                if (data) setInfo(data);
            })
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setPalette((v) => !v);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
        };
    }, []);

    if (info && !info.enabled) return null;

    const dotClass = errors.length > 0 ? 'error' : pending ? 'pending' : '';
    const pal = palette ? (
        <Palette
            routes={routes}
            onClose={() => {
                setPalette(false);
            }}
        />
    ) : null;

    if (!p.open) {
        return (
            <>
                <div className={`toil-dt ${p.side}`}>
                    <div
                        className="toil-dt-badge"
                        onClick={() => {
                            setPrefs({ open: true });
                        }}
                        title="toiljs devtools (cmd+K)">
                        <ToilLogo size={16} />
                        <span className={`toil-dt-dot ${dotClass}`} />
                    </div>
                </div>
                {pal}
            </>
        );
    }

    return (
        <>
            <div className={`toil-dt ${p.side}`}>
                <div className="toil-dt-panel">
                    <div className="toil-dt-head">
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <ToilLogo size={14} />
                            <span className="toil-dt-logo">toiljs</span> devtools
                            <span className={`toil-dt-dot ${dotClass}`} />
                        </span>
                        <button
                            className="toil-dt-x"
                            onClick={() => {
                                setPrefs({ open: false });
                            }}>
                            ✕
                        </button>
                    </div>
                    <div className="toil-dt-tabs">
                        {TABS.map((t) => (
                            <button
                                key={t.id}
                                className={`toil-dt-tab ${p.tab === t.id ? 'active' : ''}`}
                                onClick={() => {
                                    setPrefs({ tab: t.id });
                                }}>
                                {t.label}
                                {t.id === 'errors' && errors.length > 0
                                    ? ` (${String(errors.length)})`
                                    : ''}
                            </button>
                        ))}
                    </div>
                    {p.tab === 'route' && (
                        <RouteTab
                            routes={routes}
                            slots={slots}
                            info={info}
                        />
                    )}
                    {p.tab === 'data' && <DataTab />}
                    {p.tab === 'head' && <HeadTab />}
                    {p.tab === 'build' && <BuildTab info={info} />}
                    {p.tab === 'errors' && <ErrorsTab />}
                    {p.tab === 'ai' && (
                        <AiTab
                            info={info}
                            routes={routes}
                        />
                    )}
                    {p.tab === 'prefs' && <PrefsTab />}
                </div>
            </div>
            {pal}
        </>
    );
}

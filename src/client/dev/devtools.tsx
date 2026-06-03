/**
 * Development-only dev toolbar. A floating badge (bottom corner) that expands into a tabbed panel
 * showing the matched route, build/config info, captured errors, and preferences, with live feature
 * toggles, click-to-navigate, and open-in-editor. Rendered as a sibling at the app root in dev only
 * (see `mount`), behind `isDevMode()`, so the whole module is dead-code-eliminated in production.
 *
 * It stays decoupled from the Router (it computes the current match itself via `matchRoute`) so it
 * renders even when the app tree has crashed.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { type DevError, getErrorLog, subscribeErrors } from './error-overlay.js';
import {
    isNavigationPending,
    navigate,
    setTransitions,
    setViewTransitions,
    subscribeLocation,
    subscribePending,
} from '../navigation/navigation.js';
import { matchRoute } from '../routing/match.js';
import type { Href, RouteDef } from '../types.js';

type Tab = 'route' | 'build' | 'errors' | 'prefs';

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
                    <stop offset="0" stopColor="#6990ff" />
                    <stop offset=".28" stopColor="#521be0" />
                    <stop offset=".66" stopColor="#6900f4" />
                    <stop offset="1" stopColor="#7f00f6" />
                </linearGradient>
                <linearGradient
                    id="toilDtB"
                    x1="149.99"
                    y1="355.49"
                    x2="149.99"
                    y2="0"
                    gradientUnits="userSpaceOnUse">
                    <stop offset=".15" stopColor="#6990ff" stopOpacity=".6" />
                    <stop offset=".55" stopColor="#531ae1" />
                </linearGradient>
            </defs>
            <rect width="500" height="500" rx="130" ry="130" fill="url(#toilDtA)" />
            <path d="M299.98,0L0,355.49v-225.49C0,58.2,58.2,0,130,0h169.98Z" fill="url(#toilDtB)" />
            <path
                d="M106.17,111.11h285.24c9.9,0,16.7,9.96,13.09,19.18l-17.98,45.96c-2.11,5.39-7.31,8.94-13.09,8.94h-74.65c-7.76,0-14.06,6.29-14.06,14.06v214.94c0,7.76-6.29,14.06-14.06,14.06h-45.96c-7.76,0-14.06-6.29-14.06-14.06v-217.25c0-7.76-6.29-14.06-14.06-14.06h-73.66c-5.82,0-11.04-3.59-13.12-9.02l-16.76-43.64c-3.54-9.21,3.26-19.1,13.12-19.1Z"
                fill="#fff"
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

let prefs: Prefs = typeof localStorage !== 'undefined' ? loadPrefs() : defaultPrefs;
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

            <p className="toil-dt-sec" style={{ marginTop: 12 }}>
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
    if (errors.length === 0) return <p className="toil-dt-empty toil-dt-body">No errors captured.</p>;
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
    { id: 'build', label: 'Build' },
    { id: 'errors', label: 'Errors' },
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

    useEffect(() => {
        injectStyles();
        void fetch('/__toil/devinfo')
            .then((r) => (r.ok ? (r.json() as Promise<DevInfo>) : null))
            .then((data) => {
                if (data) setInfo(data);
            })
            .catch(() => undefined);
    }, []);

    if (info && !info.enabled) return null;

    const dotClass = errors.length > 0 ? 'error' : pending ? 'pending' : '';

    if (!p.open) {
        return (
            <div className={`toil-dt ${p.side}`}>
                <div
                    className="toil-dt-badge"
                    onClick={() => {
                        setPrefs({ open: true });
                    }}
                    title="toiljs devtools">
                    <ToilLogo size={16} />
                    <span className={`toil-dt-dot ${dotClass}`} />
                </div>
            </div>
        );
    }

    return (
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
                            {t.id === 'errors' && errors.length > 0 ? ` (${String(errors.length)})` : ''}
                        </button>
                    ))}
                </div>
                {p.tab === 'route' && <RouteTab routes={routes} slots={slots} info={info} />}
                {p.tab === 'build' && <BuildTab info={info} />}
                {p.tab === 'errors' && <ErrorsTab />}
                {p.tab === 'prefs' && <PrefsTab />}
            </div>
        </div>
    );
}

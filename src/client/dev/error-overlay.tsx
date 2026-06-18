/**
 * Development-only error overlay. In dev, surfaces errors that would otherwise leave a blank page or
 * live only in the console: uncaught render errors (incl. those thrown by a loader during render),
 * plus `window` `error` / `unhandledrejection` events. Shows the message, stack, and (for render
 * errors) the React component stack, with Dismiss / Reload. Inert in production builds.
 */
import {
    Component,
    type CSSProperties,
    type ErrorInfo,
    type ReactNode,
    useSyncExternalStore,
} from 'react';

/** A captured dev error. */
export interface DevError {
    readonly error: Error;
    readonly componentStack?: string;
    /** Where it came from, a render boundary, a window `error`, or an unhandled rejection. */
    readonly source: 'render' | 'window' | 'unhandledrejection';
    /** Capture time (ms epoch). */
    readonly time: number;
}

let current: DevError | null = null;
const listeners = new Set<() => void>();
/**
 * Bounded history of captured errors, for the dev toolbar's Errors tab. Reassigned to a new array
 * on each change (never mutated in place) so `getErrorLog` is a stable useSyncExternalStore snapshot:
 * the reference changes only when the log changes, so React re-renders on new errors but not in a loop.
 */
let errorLog: readonly DevError[] = [];
const MAX_LOG = 50;

function emit(): void {
    for (const listener of listeners) listener();
}
function setDevError(next: DevError | null): void {
    current = next;
    if (next) {
        errorLog = [...errorLog, next].slice(-MAX_LOG);
    }
    emit();
}
function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The captured-error history (most recent last). Subscribe via {@link subscribeErrors}. */
export function getErrorLog(): readonly DevError[] {
    return errorLog;
}
/** Subscribes to error captures (fires whenever a new error is recorded or dismissed). */
export const subscribeErrors = subscribe;

/** True when running under Vite's dev server (replaced at build time; falsy in production). */
export function isDevMode(): boolean {
    try {
        return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
    } catch {
        return false;
    }
}

let windowBound = false;
/** Wires `window` error / unhandledrejection into the overlay (idempotent; dev only). */
export function initDevErrorOverlay(): void {
    if (windowBound || typeof window === 'undefined') return;
    windowBound = true;
    window.addEventListener('error', (event) => {
        if (event.error instanceof Error) {
            setDevError({ error: event.error, source: 'window', time: Date.now() });
        }
    });
    window.addEventListener('unhandledrejection', (event) => {
        const reason: unknown = event.reason;
        const error = reason instanceof Error ? reason : new Error(String(reason));
        setDevError({ error, source: 'unhandledrejection', time: Date.now() });
    });
}

interface BoundaryProps {
    readonly children: ReactNode;
}
interface BoundaryState {
    readonly crashed: boolean;
}

/**
 * Catches render errors in its subtree and reports them to the overlay. While crashed it renders
 * nothing (the subtree threw); it recovers when the overlay is dismissed. Class component because
 * React error boundaries have no hook equivalent.
 */
export class DevErrorBoundary extends Component<BoundaryProps, BoundaryState> {
    public state: BoundaryState = { crashed: false };
    private unsubscribe: (() => void) | undefined;

    public static getDerivedStateFromError(): BoundaryState {
        return { crashed: true };
    }

    public override componentDidCatch(error: Error, info: ErrorInfo): void {
        setDevError({
            error,
            componentStack: info.componentStack ?? undefined,
            source: 'render',
            time: Date.now(),
        });
    }

    public override componentDidMount(): void {
        // Recover (re-render children) once the error is dismissed from the overlay.
        this.unsubscribe = subscribe(() => {
            if (current === null && this.state.crashed) this.setState({ crashed: false });
        });
    }

    public override componentWillUnmount(): void {
        this.unsubscribe?.();
    }

    public override render(): ReactNode {
        return this.state.crashed ? null : this.props.children;
    }
}

const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 2147483647,
    background: 'rgba(8, 8, 12, 0.88)',
    color: '#f5f6fa',
    font: '13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '2rem',
    overflow: 'auto',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
};
const panelStyle: CSSProperties = {
    maxWidth: 900,
    width: '100%',
    background: '#15151c',
    border: '1px solid #ef4444',
    borderRadius: 10,
    padding: '1.25rem 1.5rem',
    boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
};
const titleStyle: CSSProperties = {
    margin: 0,
    color: '#ff6b6b',
    fontSize: '1rem',
    fontWeight: 700,
    wordBreak: 'break-word',
};
const preStyle: CSSProperties = {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: '0.75rem 0 0',
    color: '#c8cee0',
};
const buttonStyle: CSSProperties = {
    font: 'inherit',
    color: '#f5f6fa',
    background: '#2a2a36',
    border: '1px solid #3a3a48',
    borderRadius: 6,
    padding: '0.4em 1em',
    cursor: 'pointer',
    marginRight: '0.5rem',
};

const SOURCE_LABEL: Record<DevError['source'], string> = {
    render: 'Render error',
    window: 'Uncaught error',
    unhandledrejection: 'Unhandled promise rejection',
};

/** Renders the overlay when a dev error is captured. Mount once at the app root (dev only). */
export function DevErrorOverlay(): ReactNode {
    const devError = useSyncExternalStore(
        subscribe,
        () => current,
        () => null,
    );
    if (!devError) return null;
    return (
        <div
            style={overlayStyle}
            role="alert">
            <div style={panelStyle}>
                <p style={titleStyle}>
                    {SOURCE_LABEL[devError.source]}, {devError.error.name}: {devError.error.message}
                </p>
                {devError.error.stack !== undefined && (
                    <pre style={preStyle}>{devError.error.stack}</pre>
                )}
                {devError.componentStack !== undefined && (
                    <pre style={{ ...preStyle, color: '#8b9ab4' }}>{devError.componentStack}</pre>
                )}
                <div style={{ marginTop: '1.25rem' }}>
                    <button
                        type="button"
                        style={buttonStyle}
                        onClick={() => {
                            setDevError(null);
                        }}>
                        Dismiss
                    </button>
                    <button
                        type="button"
                        style={buttonStyle}
                        onClick={() => {
                            window.location.reload();
                        }}>
                        Reload
                    </button>
                </div>
            </div>
        </div>
    );
}

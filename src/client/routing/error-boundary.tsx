import { Component, Suspense, type ComponentType, type ReactNode } from 'react';

import type { RouteErrorProps } from '../types.js';

interface ErrorBoundaryProps {
    readonly fallback: ComponentType<RouteErrorProps>;
    readonly children: ReactNode;
}
interface ErrorBoundaryState {
    readonly error: Error | null;
}

/**
 * Catches render errors in its subtree and shows the route's `error.tsx` (with a `reset` to retry).
 * Error boundaries must be class components, React has no hook equivalent.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    reset = (): void => {
        this.setState({ error: null });
    };

    render(): ReactNode {
        const { error } = this.state;
        if (error) {
            const Fallback = this.props.fallback;
            return (
                <Suspense fallback={null}>
                    <Fallback
                        error={error}
                        reset={this.reset}
                    />
                </Suspense>
            );
        }
        return this.props.children;
    }
}

import { type ReactElement } from 'react';

/**
 * Placeholder client runtime component. Proves the TSX/React toolchain compiles.
 * The real toiljs client framework (with injected native types) replaces this.
 */
export interface AppProps {
    readonly title: string;
}

export function App({ title }: AppProps): ReactElement {
    return <main className="toil-app">{title}</main>;
}

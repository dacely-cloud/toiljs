import { type ReactNode } from 'react';

// Like `layout.tsx`, but re-mounted on every navigation (keyed by pathname) instead of persisting.
// Use it for per-navigation effects — enter animations, resetting state, replaying transitions.
export default function Template({ children }: { children?: ReactNode }) {
    return <div className="route-transition">{children}</div>;
}

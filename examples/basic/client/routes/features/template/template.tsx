import { type ReactNode, useState } from 'react';

// A template wraps a segment like a layout, but RE-MOUNTS on every navigation within it (a layout
// persists). This counter increments each time the template mounts, so navigating between the two
// child links below bumps it, proving the remount. Swap this file for `layout.tsx` and the number
// would hold steady instead.
let mounts = 0;
export default function PlaygroundTemplate({ children }: { children?: ReactNode }) {
    const [mountId] = useState(() => ++mounts);
    return (
        <div>
            <p style={{ opacity: 0.6 }}>template mount #{mountId} (it increments on every navigation here)</p>
            {children}
        </div>
    );
}

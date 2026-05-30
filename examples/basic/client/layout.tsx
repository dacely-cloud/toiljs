import { type ReactNode } from 'react';

import { Link } from 'toiljs/client';

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '2rem auto' }}>
            <header style={{ borderBottom: '1px solid #ddd', paddingBottom: 8, marginBottom: 16 }}>
                <strong>Toil</strong> — <Link href="/">home</Link> · <Link href="/about">about</Link>
            </header>
            {children}
        </div>
    );
}

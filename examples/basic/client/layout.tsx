import { type ReactNode } from 'react';

import { Link } from 'toiljs/client';

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '3rem 1.5rem' }}>
            <header
                style={{
                    display: 'flex',
                    gap: '1rem',
                    alignItems: 'baseline',
                    borderBottom: '1px solid #1b2330',
                    paddingBottom: '0.75rem',
                    marginBottom: '1.5rem'
                }}>
                <strong style={{ color: '#2563FF', fontSize: '1.1rem' }}>Toil</strong>
                <nav style={{ display: 'flex', gap: '1rem' }}>
                    <Link href="/">home</Link>
                    <Link href="/about">about</Link>
                </nav>
            </header>
            {children}
        </div>
    );
}

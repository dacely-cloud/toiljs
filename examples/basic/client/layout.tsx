import { type ReactNode } from 'react';

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '3rem 1.5rem' }}>
            <img src={'images/logo.svg'} alt={'bob'}></img>
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
                    <Toil.Link href="/">home</Toil.Link>
                    <Toil.Link href="/about">about</Toil.Link>
                </nav>
            </header>
            {children}
        </div>
    );
}

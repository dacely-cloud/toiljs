import { type ReactNode } from 'react';

import { Link } from 'toiljs/client';

const styles = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #080D11; color: #F5F6FA; font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; }
  a { color: #2563FF; text-decoration: none; }
  a:hover { color: #22E3AB; }
  code { background: #11161f; color: #22E3AB; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
  h1 { background: linear-gradient(90deg, #2563FF, #7C3AED, #22E3AB); -webkit-background-clip: text; background-clip: text; color: transparent; }
`;

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '3rem 1.5rem' }}>
            <style>{styles}</style>
            <header
                style={{
                    display: 'flex',
                    gap: '1rem',
                    alignItems: 'baseline',
                    borderBottom: '1px solid #1b2330',
                    paddingBottom: '0.75rem',
                    marginBottom: '1.5rem',
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

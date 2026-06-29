import { type ReactNode } from 'react';
import Footer from './components/Footer';
import Header from './components/Header';
import HoneycombBackground from './components/HoneycombBackground';

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div className="app">
            <HoneycombBackground />
            {/* Site-wide head defaults: a fallback title + description for any route that sets none.
                A route's own `metadata` / `<Head>` overrides these. */}
            <Toil.Head
                title="ToilJS"
                meta={[{ name: 'description', content: 'Planet-scale apps from a single repo.' }]}
            />
            <Header />

            <main className="content">{children}</main>

            <Footer />
        </div>
    );
}

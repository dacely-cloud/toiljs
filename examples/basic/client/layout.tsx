import { type ReactNode } from 'react';
import Footer from './components/Footer';
import Header from './components/Header';
import HoneycombBackground from './components/HoneycombBackground';

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div className="app">
            <HoneycombBackground />
            {/* Site-wide head defaults. `titleTemplate` wraps each route's own title (a route metadata
                title of "About" renders as "About | ToilJS"); a route opts out by setting its own
                `titleTemplate: '%s'`. `title` is the fallback for routes that set none. */}
            <Toil.Head
                titleTemplate="%s | ToilJS"
                title="ToilJS"
                meta={[{ name: 'description', content: 'Planet-scale apps from a single repo.' }]}
            />
            <Header />

            <main className="content">{children}</main>

            <Footer />
        </div>
    );
}

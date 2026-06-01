import { type ReactNode } from 'react';
import Footer from './components/Footer';
import Header from './components/Header';
import HoneycombBackground from './components/HoneycombBackground';

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div className="app">
            <HoneycombBackground />
            <Toil.Head
                titleTemplate="%s By Dacely"
                title="ToilJS"
                meta={[{ name: 'description', content: 'The most performant React framework.' }]}
            />
            <Header />

            <main className="content">{children}</main>

            <Footer />
        </div>
    );
}

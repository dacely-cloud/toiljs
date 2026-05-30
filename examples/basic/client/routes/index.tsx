import { Link } from 'toiljs/client';

export default function Home() {
    return (
        <main>
            <h1>Welcome to Toil</h1>
            <p>File-based routing, bundled by Vite, zero config.</p>
            <p>
                <Link href="/about">About</Link> · <Link href="/blog/42">Blog post 42</Link>
            </p>
        </main>
    );
}

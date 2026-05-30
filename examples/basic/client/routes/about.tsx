import { Link } from 'toiljs/client';

export default function About() {
    return (
        <main>
            <h1>About</h1>
            <p>This page is served by <code>client/routes/about.tsx</code>.</p>
            <Link href="/">Back home</Link>
        </main>
    );
}

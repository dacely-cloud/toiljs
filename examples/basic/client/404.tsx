import { Link } from 'toiljs/client';

export default function NotFound() {
    return (
        <main>
            <h1>404 — Page not found</h1>
            <p>
                This custom page is served from <code>client/404.tsx</code> whenever no route
                matches.
            </p>
            <Link href="/">Back home</Link>
        </main>
    );
}

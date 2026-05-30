import { Link, useParams } from 'toiljs/client';

export default function Docs() {
    const { slug } = useParams();
    return (
        <main>
            <h1>Docs</h1>
            <p>
                Catch-all route <code>client/routes/docs/[...slug].tsx</code> matched:{' '}
                <code>{slug}</code>
            </p>
            <Link href="/">Back home</Link>
        </main>
    );
}

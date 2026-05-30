import { Link, useParams } from 'toiljs/client';

export default function BlogPost() {
    const { id } = useParams();
    return (
        <main>
            <h1>Blog post {id}</h1>
            <p>
                Dynamic route from <code>client/routes/blog/[id].tsx</code>.
            </p>
            <Link href="/">Back home</Link>
        </main>
    );
}

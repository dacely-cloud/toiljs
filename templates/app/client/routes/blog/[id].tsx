export default function BlogPost() {
    const { id } = Toil.useParams();
    return (
        <main>
            <h1>Blog post {id}</h1>
            <p>
                Dynamic route from <code>client/routes/blog/[id].tsx</code>.
            </p>
            <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}

export default function Docs() {
    const { slug } = Toil.useParams();
    return (
        <main>
            <h1>Docs</h1>
            <p>
                Catch-all route <code>client/routes/docs/[...slug].tsx</code> matched: <code>{slug}</code>
            </p>
            <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}

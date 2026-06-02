export const metadata: Toil.Metadata = { title: 'Optional catch-all' };

// Optional catch-all: `[[...slug]]` matches the bare `/files` AND any depth below it (`/files/a/b`).
// `slug` is undefined at the base and a path string when segments are present.
export default function Files() {
    const { slug } = Toil.useParams();
    return (
        <main>
            <h1>Optional catch-all</h1>
            <p>
                <code>files/[[...slug]].tsx</code> matched. Current slug:{' '}
                <code>{slug ?? '(none, this is the base /files)'}</code>
            </p>
            <p>
                <Toil.Link href="/files">/files</Toil.Link>{' '}
                <Toil.Link href="/files/images/logo">/files/images/logo</Toil.Link>{' '}
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

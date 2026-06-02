export const metadata: Toil.Metadata = { title: 'Privacy' };

// Route group: the `(legal)` folder organizes files without adding a URL segment, so this route is
// served at `/privacy`, not `/legal/privacy`. Groups can carry their own layout too.
export default function Privacy() {
    return (
        <main>
            <h1>Privacy</h1>
            <p>
                Served at <code>/privacy</code> from <code>routes/(legal)/privacy.tsx</code>. The
                <code> (legal)</code> group adds no URL segment.
            </p>
            <p>
                <Toil.Link href="/terms">Terms</Toil.Link>{' '}
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

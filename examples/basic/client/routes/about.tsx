// Declarative per-route SEO, resolved by the router into <title> + <meta>/<link> tags, and baked
// into static HTML at build (see build/client/about/index.html). Component-level useHead/<Head>
// can override it.
export const metadata: Toil.Metadata = {
    title: 'About',
    description: 'About the ToilJS example app.',
    openGraph: { title: 'About, ToilJS', type: 'website' }
};

export default function About() {
    return (
        <main>
            <h1>About</h1>
            <p>
                This page is served by <code>client/routes/about.tsx</code>. Its tab title comes from the{' '}
                <code>metadata</code> export above, wrapped by the layout template into <code>About | ToilJS</code>.
            </p>
            <Toil.Link href="/features">See every feature</Toil.Link>
        </main>
    );
}

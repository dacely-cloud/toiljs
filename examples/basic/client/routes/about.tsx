// Declarative per-route SEO — resolved by the router into <title> + <meta>/<link> tags. The root
// layout's titleTemplate (if any) still applies; component-level useHead/<Head> can override.
export const metadata: Toil.Metadata = {
    title: 'About',
    description: 'About the ToilJS example app.',
    openGraph: { title: 'About · ToilJS', type: 'website' },
};

export default function About() {
    return (
        <main>
            <h1>About</h1>
            <p>
                This page is served by <code>client/routes/about.tsx</code>.
            </p>
            <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}

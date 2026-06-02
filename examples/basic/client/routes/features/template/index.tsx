export const metadata: Toil.Metadata = { title: 'Templates' };

export default function TemplateDemo() {
    return (
        <main>
            <h1>Templates</h1>
            <p>
                The line above is rendered by <code>template.tsx</code>. Bounce between these two links
                and watch the mount number climb, the template remounts on every navigation.
            </p>
            <p>
                <Toil.Link href="/features/template">This page</Toil.Link>{' '}
                <Toil.Link href="/features/template/b">Sibling page</Toil.Link>
            </p>
            <p>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

export const metadata: Toil.Metadata = { title: 'Templates, sibling' };

export default function TemplateSibling() {
    return (
        <main>
            <h1>Sibling page</h1>
            <p>Same template, fresh mount. Navigate back and forth to see the counter increment.</p>
            <p>
                <Toil.Link href="/features/template">First page</Toil.Link>{' '}
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

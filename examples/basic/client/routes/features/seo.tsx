// Route metadata: the declarative way to set this page's <title>, description, OpenGraph, and more.
// The router applies it before paint and the build bakes it into static HTML for crawlers.
//
// This route sets its OWN `titleTemplate: '%s'`, which overrides the layout's "%s | ToilJS" template,
// so the tab reads exactly "useReducer | React Hooks" with no site suffix. Drop the titleTemplate
// line and the same title renders as "useReducer | React Hooks | ToilJS".
export const metadata: Toil.Metadata = {
    title: 'useReducer | React Hooks',
    titleTemplate: '%s',
    description: 'Manage complex state transitions with a reducer function using the useReducer hook.',
    keywords: ['react', 'hooks', 'useReducer', 'state'],
    canonical: 'https://toil.example/features/seo',
    openGraph: {
        title: 'useReducer | React Hooks',
        description: 'Manage complex state transitions with a reducer.',
        type: 'website'
    }
};

export default function SeoDemo() {
    return (
        <main>
            <h1>Route metadata</h1>
            <p>
                The browser tab now reads <strong>useReducer | React Hooks</strong>, set entirely by the{' '}
                <code>metadata</code> export in <code>client/routes/features/seo.tsx</code>, with no{' '}
                <code>useEffect</code> and no title suffix.
            </p>
            <p>
                It also emitted <code>&lt;meta name="description"&gt;</code>, keywords, a canonical link, and the{' '}
                <code>og:*</code> tags, all from that one object.
            </p>
            <p>
                <Toil.Link href="/features/head">Prefer the imperative API?</Toil.Link>{' '}
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

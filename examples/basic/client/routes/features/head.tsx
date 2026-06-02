import { useState } from 'react';

// The imperative head API, for when the title or tags depend on component state rather than a static
// export. `useTitle` / `useHead` apply for the component's lifetime and revert on unmount; `<Toil.Head>`
// is the declarative form. They compose with (and can override) the route `metadata`.
export default function HeadDemo() {
    const [count, setCount] = useState(0);

    // Live title: the tab updates every render as `count` changes.
    Toil.useTitle(`Clicked ${count} times`);

    // Add a meta tag and a canonical link for this page only.
    Toil.useHead({
        meta: [{ name: 'description', content: `Imperative head demo, clicked ${count} times.` }],
        link: [{ rel: 'canonical', href: 'https://toil.example/features/head' }]
    });

    return (
        <main>
            <h1>Imperative head</h1>
            <p>
                The tab title is driven by component state via <code>Toil.useTitle</code>. Click the button and watch it
                change, then leave the page and the title reverts.
            </p>
            <p>
                <button type="button" onClick={() => setCount((c) => c + 1)}>
                    Clicked {count} times
                </button>
            </p>
            {/* Declarative equivalent, the same merge rules apply. */}
            <Toil.Head meta={[{ property: 'og:title', content: `Clicked ${count} times` }]} />
            <p>
                <Toil.Link href="/features/seo">Compare with route metadata</Toil.Link>{' '}
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

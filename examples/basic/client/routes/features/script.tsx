import { useState } from 'react';

export const metadata: Toil.Metadata = {
    title: 'Script',
    description: 'Load third-party scripts with a strategy, deduplicated so they never run twice.',
};

// Toil.Script injects an external or inline script once (deduped by src/id), with a load strategy.
// `onReady` fires when it has loaded. Here we load a tiny public script and report when it is ready.
export default function ScriptDemo() {
    const [ready, setReady] = useState(false);
    return (
        <main>
            <h1>Script</h1>
            <p>
                <code>Toil.Script</code> loads external scripts with a <code>strategy</code>{' '}
                (<code>afterInteractive</code>, <code>lazyOnload</code>, <code>beforeInteractive</code>)
                and dedupes them, so the same script never runs twice across navigations.
            </p>
            <Toil.Script
                src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"
                strategy="afterInteractive"
                onReady={() => setReady(true)}
            />
            <p>Status: {ready ? 'script ready' : 'loading'}</p>
            <p>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

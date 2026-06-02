import { useState } from 'react';

export const metadata: Toil.Metadata = { title: 'Error boundary' };

// When a route throws during render, the nearest `error.tsx` catches it and renders instead of a
// blank screen. Click the button to flip into a throwing render and watch error.tsx take over.
export default function ErrorDemo() {
    const [boom, setBoom] = useState(false);
    if (boom) throw new Error('Kaboom from features/error, caught by error.tsx');
    return (
        <main>
            <h1>Error boundary</h1>
            <p>
                A thrown render is caught by <code>error.tsx</code> in this folder, scoped to this
                segment so the rest of the app keeps working.
            </p>
            <p>
                <button type="button" onClick={() => setBoom(true)}>
                    Throw an error
                </button>
            </p>
            <p>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

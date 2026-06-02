// The error boundary for this segment. It receives the thrown error and a `reset` to retry the
// render. Place an `error.tsx` next to any route to contain failures there.
export default function FeatureError({ error, reset }: Toil.RouteErrorProps) {
    return (
        <main>
            <h1>Something broke</h1>
            <p style={{ color: 'crimson' }}>{error instanceof Error ? error.message : String(error)}</p>
            <p>
                <button type="button" onClick={reset}>
                    Try again
                </button>{' '}
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

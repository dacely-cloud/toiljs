// Root error boundary. Unlike a route's `error.tsx`, this sits *outside* the root layout, so it
// also catches errors thrown while rendering the layout itself — the last line of defense.
export default function GlobalError({ error, reset }: Toil.RouteErrorProps) {
    return (
        <main className="global-error">
            <h1>Something went wrong</h1>
            <p className="global-error-message">{error.message}</p>
            <button type="button" onClick={reset}>
                Try again
            </button>
        </main>
    );
}

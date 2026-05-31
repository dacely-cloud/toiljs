// Shown as the Suspense fallback while this route's `loader` runs (and its chunk loads). Because the
// loader awaits 2s, you'll see this spinner before the page renders with its data.
export default function LoaderDemoLoading() {
    return (
        <main>
            <div className="loading-bar" />
            <div className="loading-center">
                <span className="spinner" aria-hidden="true" />
                <p>Loading data…</p>
            </div>
        </main>
    );
}

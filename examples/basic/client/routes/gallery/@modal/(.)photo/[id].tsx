// Intercepting route: `(.)photo/[id]` inside the `@modal` slot catches a soft navigation to
// /gallery/photo/:id and renders here instead, as an overlay, while the gallery stays mounted behind
// it. On a hard reload the interception does not apply and the full photo/[id].tsx page renders.
export default function PhotoModal() {
    const { id } = Toil.useParams();
    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.6)',
                display: 'grid',
                placeItems: 'center',
                zIndex: 50,
            }}>
            <div style={{ background: 'var(--bg, #0b0f14)', padding: 24, borderRadius: 12, minWidth: 240 }}>
                <h2>Photo {id}</h2>
                <p>This is the intercepted modal view (soft navigation).</p>
                <Toil.Link href="/gallery">Close</Toil.Link>
            </div>
        </div>
    );
}

export const metadata: Toil.Metadata = {
    title: 'Gallery',
    description: 'Parallel routes and intercepting routes: a photo opens as a modal on soft nav.'
};

const photos = [1, 2, 3, 4];

// Clicking a photo soft-navigates to /gallery/photo/:id. The intercepting route @modal/(.)photo/[id]
// catches that on soft nav and shows it as a modal over this grid. A hard reload of the same URL
// renders the full page (photo/[id].tsx) instead, deep links still work.
export default function Gallery() {
    return (
        <main>
            <h1>Gallery</h1>
            <p>
                Click a photo, it opens as a modal (intercepting route). Reload that URL and you get the full page. Same
                URL, two presentations.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {photos.map((id) => (
                    <Toil.Link
                        key={id}
                        href={`/gallery/photo/${id}`}
                        style={{
                            width: 88,
                            height: 88,
                            display: 'grid',
                            placeItems: 'center',
                            border: '1px solid currentColor',
                            borderRadius: 8,
                            fontWeight: 700
                        }}>
                        {id}
                    </Toil.Link>
                ))}
            </div>
            <p style={{ marginTop: 16 }}>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

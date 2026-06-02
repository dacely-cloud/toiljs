export const generateMetadata: Toil.GenerateMetadata = ({ params }) => ({
    title: `Photo ${params.id}`,
});

// The full page for a photo, shown on a hard load or deep link to /gallery/photo/:id.
export default function PhotoPage() {
    const { id } = Toil.useParams();
    return (
        <main>
            <h1>Photo {id}</h1>
            <p>
                Full page at <code>gallery/photo/[id].tsx</code>. Reached directly (reload or deep
                link), not intercepted.
            </p>
            <Toil.Link href="/gallery">Back to gallery</Toil.Link>
        </main>
    );
}

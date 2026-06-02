export const metadata: Toil.Metadata = { title: 'Terms' };

export default function Terms() {
    return (
        <main>
            <h1>Terms</h1>
            <p>
                Also in the <code>(legal)</code> group, served at <code>/terms</code>.
            </p>
            <p>
                <Toil.Link href="/privacy">Privacy</Toil.Link> <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

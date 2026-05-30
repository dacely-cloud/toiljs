export default function Home() {
    return (
        <main>
            <h1>Welcome to Toil</h1>
            <p>File-based routing, bundled by Vite, zero config.</p>
            <p>
                <Toil.Link href="/about">About</Toil.Link> · <Toil.Link href="/blog/42">Blog post 42</Toil.Link>
            </p>
        </main>
    );
}

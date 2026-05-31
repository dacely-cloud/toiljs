async function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loader = async ({ searchParams }: Toil.LoaderArgs) => {
    await wait(2000);
    return { loadedAt: new Date().toISOString(), q: searchParams.get('q') };
};

export default function LoaderDemo() {
    const data = Toil.useLoaderData<{ loadedAt: string; q: string | null }>();
    return (
        <main>
            <h1>Loader demo</h1>
            <p>
                Data loaded before render (no <code>useEffect</code>): <code>{data.loadedAt}</code>
                {data.q !== null ? ` · q=${data.q}` : ''}
            </p>
            <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}

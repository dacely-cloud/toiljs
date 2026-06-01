async function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loader = async ({ searchParams }: Toil.LoaderArgs) => {
    await wait(2000);
    return { loadedAt: new Date().toISOString(), q: searchParams.get('q') };
};

// Cache this route's data for 10s: revisiting within 10s is instant (no 2s wait); after that it
// refetches on navigation. Use `false` to cache forever, or omit for the default (refetch every nav).
export const revalidate: Toil.Revalidate = 10;

export default function LoaderDemo() {
    // `typeof loader` infers the data type from the loader above — no need to restate the shape.
    const data = Toil.useLoaderData<typeof loader>();
    const router = Toil.useRouter();
    return (
        <main>
            <h1>Loader demo</h1>
            <p>
                Data loaded before render (no <code>useEffect</code>): <code>{data.loadedAt}</code>
                {data.q !== null ? ` · q=${data.q}` : ''}
            </p>
            <p>
                <button type="button" onClick={() => { router.revalidate(); }}>
                    Revalidate (refetch)
                </button>
            </p>
            <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}

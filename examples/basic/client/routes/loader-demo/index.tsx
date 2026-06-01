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
    // Pass the loader to infer the data type from its return — no generics, no restating the shape.
    const data = Toil.useLoaderData(loader);
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
            {/* The write half: an action runs on submit, then revalidates this route's loader so
                `loadedAt` above updates — read → write → revalidate, no manual refetch. */}
            <Toil.Form action={async (form) => { await wait(500); console.log('saved', form.get('note')); }}>
                {({ pending }) => (
                    <>
                        <input name="note" placeholder="Leave a note" disabled={pending} />
                        <button type="submit" disabled={pending}>
                            {pending ? 'Saving…' : 'Save & revalidate'}
                        </button>
                    </>
                )}
            </Toil.Form>
            <Toil.Link href="/">Back home</Toil.Link>
        </main>
    );
}

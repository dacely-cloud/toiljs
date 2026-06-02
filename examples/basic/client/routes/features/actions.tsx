// Mutations: a `loader` reads, an action writes, then revalidation refetches the loader so the UI
// reflects the new state with no manual refetch. Here a module-level counter stands in for a server.
let serverCount = 0;
async function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const metadata: Toil.Metadata = {
    title: 'Actions and forms',
    description: 'useAction and <Form> mutations with pending state and revalidation.'
};

export const loader = async () => {
    await wait(150);
    return { count: serverCount };
};

export default function ActionsDemo() {
    const { count } = Toil.useLoaderData(loader);

    // useAction: run a mutation, track pending/error, then revalidate this route's loader on success.
    const increment = Toil.useAction(
        async (by: number) => {
            await wait(400);
            serverCount += by;
            return serverCount;
        },
        { revalidate: true }
    );

    return (
        <main>
            <h1>Actions and forms</h1>
            <p>
                Server count (from the loader): <strong>{count}</strong>
            </p>

            <p>
                <button type="button" disabled={increment.pending} onClick={() => void increment.run(1)}>
                    {increment.pending ? 'Saving' : 'Increment via useAction'}
                </button>
                {increment.error ? <span style={{ color: 'crimson' }}> failed</span> : null}
            </p>

            {/* The declarative form: submits to an action, revalidates on success, exposes pending. */}
            <Toil.Form
                action={async (form) => {
                    await wait(400);
                    serverCount += Number(form.get('by') || 0);
                }}
                revalidate>
                {({ pending }) => (
                    <>
                        <input name="by" type="number" defaultValue={5} disabled={pending} />
                        <button type="submit" disabled={pending}>
                            {pending ? 'Saving' : 'Add via <Form>'}
                        </button>
                    </>
                )}
            </Toil.Form>

            <p>
                <Toil.Link href="/features">Back to features</Toil.Link>
            </p>
        </main>
    );
}

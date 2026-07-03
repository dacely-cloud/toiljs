# Fetching data

Your React frontend and your toiljs backend live in one project, so toiljs generates a **typed client** that lets the browser call your server with full type safety and no hand-written `fetch` boilerplate. This page covers loading data for a page, calling the backend directly, submitting forms, and reading who is logged in.

## The generated `Server` client

When you build the server, toiljs writes a file at `shared/server.ts` that contains your `@data` classes and a typed description of every backend endpoint. Importing anything from `shared/server` attaches the runtime clients to a global called `Server`. From then on you call your backend through `Server`, fully typed, with editor autocomplete.

There are two surfaces under `Server`:

- **`Server.REST.<controller>.<route>(args)`**: a real, typed `fetch` client for your `@rest` HTTP controllers. This is the working, recommended way to call the backend today.
- **`Server.<service>.<method>(args)` and `Server.<remote>(args)`**: the typed RPC surface for `@service` / `@remote` functions.

Both are generated from your server code, so if you rename a route or change an argument type, the call site is a compile error until you fix it.

## Calling a REST endpoint

`Server.REST` mirrors your `@rest` controllers. If your backend has a `players` controller with routes on it, you call them like this:

```tsx
import { NewPlayer, ScoreDelta } from 'shared/server';

// POST /players with a typed @data body -> typed Promise<Player>
const player = await Server.REST.players.create({ body: new NewPlayer('Ada') });

// POST /players/:id/score with a path param AND a body
const updated = await Server.REST.players.addScore({
  params: { id: 1 },
  body: new ScoreDelta(5n),
});

// GET /leaderboard -> typed Promise<Standings>
const board = await Server.REST.leaderboard.top();
```

The single argument is an object with up to four optional parts:

| Key | What it is |
| --- | --- |
| `params` | Path parameters, e.g. `{ id: 1 }` for a `/players/:id` route. |
| `body` | The request body, usually a `@data` class instance. |
| `query` | Query-string values. |
| `headers` | Extra request headers. |

Return values are typed and decoded for you. A route that returns a `@data` type hands you the parsed class instance. A route that returns a raw `Response` hands you the raw fetch `Response`, so you can inspect the status and headers yourself:

```tsx
// This route returns a Response, so you get the raw fetch Response.
const res = await Server.REST.players.get({ params: { id: 1 } });
if (!res.ok) {
  console.log('status', res.status);
} else {
  const p = await res.json();
}
```

`@data` classes are the typed values that cross the wire. You import them from `shared/server` and construct them normally (`new NewPlayer('Ada')`). See [Data types](../backend/data.md) for how they are defined on the server.

### Handling errors

A failed call throws. The global `parseError` helper turns any caught value into a readable message, which is handy in a `catch`:

```tsx
try {
  const board = await Server.REST.leaderboard.top();
} catch (err) {
  console.error(parseError(err));
}
```

## Loading data for a page (loaders)

Calling the backend from a button handler (as above) is fine for actions. For the data a page needs to *render*, use a route **loader** instead of a `useEffect`. A loader runs on navigation, in parallel with loading the page's code, and the page suspends (showing its `loading.tsx`) until the data is ready:

```tsx
// client/routes/blog/[id].tsx
export const loader = async ({ params }: Toil.LoaderArgs) => {
  return Server.REST.blog.get({ params: { id: params.id } });
};

export default function BlogPost() {
  const post = Toil.useLoaderData<typeof loader>();
  return <article><h1>{post.title}</h1></article>;
}
```

`useLoaderData<typeof loader>()` is fully typed from the loader's return. This keeps data fetching declarative and out of effects, and it is what lets server-rendered pages seed the browser with the server's data so hydration stays clean.

### Caching and revalidating loader data

Loader results are cached by URL. You control how long with `export const revalidate`:

| `revalidate` value | Behavior |
| --- | --- |
| `0` (default) | Re-run the loader on every navigation to the route. |
| a number `n` | Reuse cached data for `n` seconds, then refetch. |
| `false` | Cache until you invalidate it manually. |

After a mutation (say you just POSTed a new comment), refresh the current page's data with `revalidate()` or the router:

```tsx
const router = Toil.useRouter();
await Server.REST.comments.add({ body: new NewComment(text) });
router.revalidate();            // refetch the active route's loader
// or target another route: router.revalidate('/posts');
```

`router.refresh()` re-runs the current loader and clears the cache; `router.revalidate(href)` invalidates a specific route.

## Forms

For the common "submit a form, then refresh the page's data" loop, use `Toil.Form`. It runs an async action on submit (no page reload), tracks pending and error state, and revalidates the route's loader data on success:

```tsx
import { NewMessage } from 'shared/server';

export default function Guestbook() {
  const entries = Toil.useLoaderData<typeof loader>();

  const sign = async (data: FormData) => {
    const author = String(data.get('author'));
    const message = String(data.get('message'));
    await Server.REST.guestbook.sign({ body: new NewMessage(author, message) });
  };

  return (
    <Toil.Form action={sign} resetOnSuccess>
      {({ pending }) => (
        <>
          <input name="author" />
          <input name="message" />
          <button disabled={pending}>Sign</button>
        </>
      )}
    </Toil.Form>
  );
}
```

Key `Toil.Form` props:

| Prop | Default | What it does |
| --- | --- | --- |
| `action` | (required) | Runs on submit, receiving the form's `FormData`. May be async. |
| `revalidate` | `true` (current route) | Which loader data to refetch after a successful submit. |
| `resetOnSuccess` | `false` | Clear the form fields after success. |
| `onSuccess` / `onError` | | Callbacks for the two outcomes. |

Passing a **render function** as `children` gives you live submit state (`pending`, `error`), so you can disable the button while the request is in flight. On success, `Form` revalidates the loader, so the page's data updates automatically without a manual refetch.

## Reading who is logged in

To render "logged in as ..." you need the current user. toiljs generates a `getUser()` helper (from the backend's `@user` surface) that reads the current user from a readable session cookie with no network round-trip. It is instant, which makes it perfect for display, but it is **untrusted**: a value read on the client can be forged, so never gate anything security-sensitive on it. For a trusted check, call a guarded backend route that re-verifies the signed session.

The full auth flow (post-quantum login, sessions, `getUser()`, and guarding routes) is its own guide:

- [Auth usage](../auth/usage.md): reading the session, `getUser()`, and guarding pages.

## RPC (`@service` / `@remote`)

Alongside REST, toiljs generates a typed RPC surface for `@service` methods and free `@remote` functions. These read like plain function calls with no URL:

```tsx
const n = await Server.ping(10);              // a free @remote
const count = await Server.stats.playerCount(); // a @service method
```

The types come straight from your server, so `Server.ping` knows it takes a number and returns a number. Under the hood each call encodes its arguments and POSTs them to a single reserved endpoint (`/__toil_rpc`) with a compact method id, then decodes the typed result. Both the local dev server and the production edge dispatch this endpoint, so RPC works end to end.

If a call throws an "unavailable" error, it means the generated client has not attached yet: build the server (`npm run build:server`) to regenerate `shared/server.ts`, and import from `shared/server` so the client loads (see the gotchas below). See [Typed RPC](../backend/rpc.md) for the backend side and when to choose RPC over REST.

## Gotchas

- **Import from `shared/server` to attach the clients.** `Server.REST` (and the RPC client) attach when you import from `shared/server`. Importing your `@data` classes from there does it naturally; if `Server.REST.foo()` throws an "unavailable" error, make sure the server has been built (`npm run build:server`) and that `shared/server` is imported.
- **The server runs a fresh instance per request.** In the examples, in-memory writes are previews that do not persist. To keep data, write it to the database (see [Database](../database/index.md)). This is a backend property, but it explains why a create returns a value that is not there on the next request.
- **Fetch page data in a `loader`, not `useEffect`.** A loader runs in parallel with the route chunk and integrates with `loading.tsx`, suspense, caching, and SSR hydration. A `useEffect` fetch runs only after the page mounts (slower, and invisible to the server).
- **`getUser()` is display-only.** It is fast because it does not verify anything. Do real authorization on the server.

## Related

- [Routing](./routing.md): loaders, `loading.tsx`, and navigation.
- [Backend HTTP routes](../backend/rest.md): the `@rest` controllers behind `Server.REST`.
- [Typed RPC](../backend/rpc.md): the `@service` / `@remote` surface behind `Server`.
- [Data types](../backend/data.md): the `@data` classes that cross the wire.
- [Auth usage](../auth/usage.md): sessions and `getUser()`.

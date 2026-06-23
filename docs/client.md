# Client runtime

Everything is on the `Toil` global, no imports needed in route files.

## Entry

`client/toil.tsx` imports the route table + global styles and mounts the app:

```tsx
import { routes, layout, notFound } from "toiljs/routes";
import "./styles/main.css";
Toil.mount(routes, layout, notFound);
```

## API (on `Toil`)

- Components: `Link`, `NavLink`, `Head`
- Navigation: `navigate`, `useRouter`, `useNavigate`
- Location: `usePathname`, `useSearchParams`, `useParams`, `useNavigationPending`
- Data: `useLoaderData` (see [routing.md](./routing.md))
- Head: `useHead`, `useTitle`, `<Head>`, set the `<title>` / meta per route
- Realtime: `useChannel`, `connectChannel` (WebSocket to the backend at `/_toil`)
- IO globals (no `Toil.` prefix): `FastMap`, `FastSet`, `DataWriter`, `DataReader`
- `parseError(err)` global: message from an unknown caught value (handy in `catch`)
- `Server` global: the typed RPC surface generated from the server (see [server.md](./server.md))
- `Server.REST.<controller>.<route>(args)`: a working, typed `fetch` client for your
  `@rest` controllers, e.g. `await Server.REST.todos.getTodo({ params: { id } })` or
  `await Server.REST.todos.add({ body: new AddTodo("milk") })`. `args` is
  `{ params?, body?, query?, headers? }`; returns are typed (`@data` classes are parsed for
  you). The REST client attaches when you import from `shared/server`.

## Head example

```tsx
Toil.useHead({
    title: "Blog",
    titleTemplate: "%s, MyApp",
    meta: [{ name: "description", content: "..." }],
});
```

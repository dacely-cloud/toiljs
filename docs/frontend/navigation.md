# Navigation

Once your files are turned into URLs (see [Routing](./routing.md)), you need a way to move between them. This page is about that half: the links, hooks, and functions that navigate a user from one page to the next without a full reload, keep the current section highlighted, prefetch what is coming, and restore scroll. Everything here lives on the global `Toil` object, so route files need no imports for the common cases.

Routing is "file to URL"; navigation is "get me to that URL". If you are looking for how a file becomes a page, or for dynamic params and layouts, that is the [Routing](./routing.md) page.

## `Toil.Link`

`Toil.Link` is the client-side replacement for a plain `<a>`. It navigates in place (no full page reload), and it prefetches the target route's chunk on hover or focus, so the click feels instant:

```tsx
<Toil.Link href="/about">About</Toil.Link>
```

`Link` accepts every standard anchor attribute (`className`, `style`, `target`, `rel`, `download`, `referrerPolicy`, `ref`, `data-*`, `aria-*`, event handlers, and so on), plus a few toiljs controls:

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `href` | `Href` | (required) | Destination, typed to your project's real routes (a typo is a compile error). |
| `replace` | `boolean` | `false` | Replace the current history entry instead of pushing a new one. |
| `scroll` | `boolean` | `true` | Scroll to the top after navigating. `false` keeps the current position. |
| `prefetch` | `boolean` | `true` | Prefetch the route chunk on hover/focus. `false` opts this link out. |

### When `Link` does not intercept

`Link` is deliberate about when to hand a click back to the browser. It only intercepts a plain, same-origin, left-click. All of these fall through to native browser behavior instead:

- **External URLs** (a different origin), and opaque targets like `mailto:` or `tel:`.
- **`target` other than `_self`** (for example `target="_blank"`, a new tab).
- **`download`** links.
- **In-page `#hash`-only** links.
- **Modified clicks**: middle-click or any click with Ctrl, Cmd (Meta), Shift, or Alt held (so "open in new tab" keeps working).

Because of this, you can point a `Link` at an external site or a download and it behaves exactly like an `<a>` would, no special-casing on your part. For genuinely external links a plain `<a>` is still fine; reach for `Link` when the target is one of your own routes.

## `Toil.NavLink` and active state

`Toil.NavLink` is a `Link` that knows whether it points at the current page. When active it adds a class (`active` by default) and sets `aria-current="page"`, which is exactly what a navigation bar wants for highlighting the current section. It inherits Link's full anchor API and its prefetching.

On top of `LinkProps` it adds:

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `end` | `boolean` | `false` | Require an exact match. Without it, a parent link is active for its sub-paths. |
| `activeClassName` | `string` | `'active'` | The class added when active (used with a string `className`). |
| `className` | `string \| (state) => string \| undefined` | (none) | A string, or a function of `{ isActive }`. |
| `style` | `CSSProperties \| (state) => CSSProperties \| undefined` | (none) | A style object, or a function of `{ isActive }`. |
| `children` | `ReactNode \| (state) => ReactNode` | (none) | Content, or a function of `{ isActive }`. |

A simple nav bar with string classes:

```tsx
// client/components/Nav.tsx
export default function Nav() {
  return (
    <nav>
      <Toil.NavLink href="/" end>Home</Toil.NavLink>
      <Toil.NavLink href="/blog">Blog</Toil.NavLink>
      <Toil.NavLink href="/about" activeClassName="is-current">About</Toil.NavLink>
    </nav>
  );
}
```

By default a parent link stays active for its sub-paths, so `/blog` is active on `/blog`, `/blog/42`, and `/blog/42/edit`. Pass `end` to require an exact match. This matters most for the home link: `/` would otherwise be active on every page, so `Home` almost always wants `end`.

The function forms let the active state drive `className`, `style`, or `children` directly. Each receives a `{ isActive }` object:

```tsx
<Toil.NavLink href="/blog" className={({ isActive }) => (isActive ? 'tab on' : 'tab')}>
  {({ isActive }) => <span>{isActive ? '• ' : ''}Blog</span>}
</Toil.NavLink>
```

## Navigating in code

Not every navigation is a click. After a form submit, a login, or a `fetch`, you often want to move the user yourself. There are three ways, from smallest to fullest.

### `Toil.useNavigate()`

The hook returns the bare `navigate(href, options)` function:

```tsx
export default function Login() {
  const navigate = Toil.useNavigate();
  return (
    <button onClick={() => navigate('/dashboard', { replace: true })}>
      Continue
    </button>
  );
}
```

The options are `NavigateOptions`, the same two controls `Link` exposes:

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `replace` | `boolean` | `false` | Replace the current history entry instead of pushing. |
| `scroll` | `boolean` | `true` | Scroll to top after navigating. `false` keeps the position. |

### `Toil.navigate` (outside React)

The exact same function is available free of any hook as `Toil.navigate(href, options)`. Use it in code that is not a React component: a plain event handler, a utility module, or right after a `fetch` resolves:

```tsx
async function saveDraft(draft: Draft) {
  await Server.REST.posts.create({ body: draft });
  Toil.navigate('/posts');
}
```

`Toil.back()`, `Toil.forward()`, and `Toil.refresh()` are the history counterparts, also callable from anywhere: `back` and `forward` step through history, and `refresh` re-renders the current route (re-running its loader for the current URL).

### `Toil.useRouter()`

For a full imperative handle, `useRouter()` returns a `RouterInstance`:

```tsx
export default function PostActions() {
  const router = Toil.useRouter();
  return (
    <>
      <button onClick={() => router.push('/blog/new')}>New post</button>
      <button onClick={() => router.back()}>Back</button>
      <button onClick={() => router.revalidate()}>Refresh data</button>
    </>
  );
}
```

| Method | What it does |
| --- | --- |
| `push(href, options?)` | Navigate to `href`, pushing a new history entry (or replacing with `{ replace: true }`). |
| `replace(href)` | Navigate to `href`, replacing the current history entry. |
| `back()` | Go back one history entry. |
| `forward()` | Go forward one history entry. |
| `refresh()` | Re-render the current route and re-run its loader (clears all cached loader data). |
| `revalidate(href?)` | Invalidate cached loader data and re-render so it refetches. No argument targets the active route; pass an `href` for a specific route. Use after a mutation. |
| `prefetch(href)` | Warm a route's chunk ahead of navigation. |

Reach for `revalidate()` after a write (you changed some data and want the current page's loader to refetch), and `refresh()` when you want a clean re-run of everything. `push`/`replace` are the imperative twins of a `Link` click.

## Typed hrefs and the `href()` escape hatch

Every `href` you pass to `Toil.Link`, `NavLink`, `navigate`, or `router.push` is type-checked against your project's real routes. The compiler scans `client/routes/` and generates a `toil-routes.d.ts` that narrows the `Href` type to the union of your actual paths, so a typo is a compile error before you run the app:

```tsx
<Toil.Link href="/abuot">About</Toil.Link>
// ^ Type error: "/abuot" is not assignable to type 'Href'. (No such route.)
```

Dynamic routes appear in that union as template-literal types, so a file at `client/routes/blog/[id].tsx` contributes `` `/blog/${string}` `` and a single interpolation still checks:

```tsx
<Toil.Link href={`/blog/${post.id}`}>Read</Toil.Link>   // fine
```

When a URL is assembled from several data pieces (or from values TypeScript cannot prove the shape of), it is typed as a plain `string`, and `string` is not assignable to `Href`. That is when you reach for `Toil.href()`, the escape hatch that asserts a runtime string is a valid href:

```tsx
const path = `/${product.category}/${product.slug}`;   // string
Toil.navigate(Toil.href(path));                         // asserted valid
<Toil.Link href={Toil.href(path)}>Open</Toil.Link>;
```

`href()` is a pure type assertion (it returns the string unchanged), so use it only when the type-check is genuinely in your way, not to paper over a real typo. Before the routes are generated (a fresh project, the first build), `Href` is just `string`, so nothing complains until `toil-routes.d.ts` exists.

## Reading the current location

A handful of hooks let a component read where it is. Each re-reads on every navigation, so a component using one re-renders when the location changes:

| Hook | Returns |
| --- | --- |
| `Toil.usePathname()` | The current pathname, e.g. `"/blog/42"`. |
| `Toil.useLocation()` | The current pathname (an alias of `usePathname()`). |
| `Toil.useParams<T>()` | The dynamic route params, e.g. `{ id }` for `/blog/[id]`. |
| `Toil.useSearchParams()` | The query string as a `URLSearchParams`. |
| `Toil.useNavigationPending()` | `true` while a navigation is in flight (started but not committed). |

`useNavigationPending()` is what you wire a top loading bar to. It flips to `true` when a navigation begins and back to `false` once the new route commits:

```tsx
// client/components/ProgressBar.tsx
export default function ProgressBar() {
  const pending = Toil.useNavigationPending();
  return <div className="progress" data-active={pending} />;
}
```

`useSearchParams()` gives you a live `URLSearchParams`, so a filtered list reads its state from the URL:

```tsx
export default function Results() {
  const params = Toil.useSearchParams();
  const q = params.get('q') ?? '';
  return <p>Results for {q}</p>;
}
```

## Prefetching

toiljs prefetches routes before you navigate to them, so a click resolves with nothing left to download. There are two intents, both automatic:

- **Hover / focus intent.** When you hover or focus a link that points at a known internal route, toiljs warms both its route chunk and its loader data, so the actual click can commit right away.
- **Viewport intent.** As a link scrolls into view (or within about 200px of it), its route chunk is warmed. Links added later by client navigation are picked up automatically.

Prefetching is best-effort and cheap: each route loads at most once, a failed prefetch is forgotten (so the real navigation can retry and surface the error), and new-tab / download / opted-out links are skipped. It is also **skipped entirely when the browser signals data-saver** (or reports a 2g-class connection), so you never spend a metered user's bandwidth on speculation.

Opt a single link out with `prefetch={false}`, which emits a `data-no-prefetch` attribute the prefetcher respects:

```tsx
<Toil.Link href="/huge-report" prefetch={false}>Annual report</Toil.Link>
```

You can also warm a route yourself, for example right before an imperative `navigate`, with the standalone `Toil.prefetch(href)`:

```tsx
<button
  onPointerEnter={() => Toil.prefetch('/dashboard')}
  onClick={() => Toil.navigate('/dashboard')}>
  Open dashboard
</button>
```

## Scroll restoration

toiljs manages scroll for you (it switches off the browser's automatic restoration and does the intuitive thing per navigation type):

- **A push navigation** (a `Link` click, `navigate`, `router.push`) **scrolls to the top** of the new page.
- **Back and forward restore** the scroll position you had on that entry, so returning to a long list lands you where you were.
- **A `#hash` target** scrolls that element into view instead of jumping to the top.

To keep the current scroll on a push navigation, set `scroll={false}` on the `Link` (or `{ scroll: false }` in `NavigateOptions`). This is handy for tab bars or filters that change the URL but should not yank the viewport:

```tsx
<Toil.Link href="/settings/billing" scroll={false}>Billing</Toil.Link>
```

```tsx
navigate('/settings/billing', { scroll: false });
```

## Animated transitions

Two optional effects can animate navigations. Both are **off by default** and are normally enabled from `toil.config.ts`, not in code:

```ts
// toil.config.ts
export default {
  client: {
    viewTransitions: true, // browser View Transitions API (a crossfade between pages)
    transitions: true,     // React transition: keep the old page visible while the next loads
  },
};
```

`viewTransitions` uses the browser's View Transitions API to crossfade the old and new page (and it respects `prefers-reduced-motion`, animating nothing for users who ask for less motion). `transitions` wraps each navigation in a React transition, keeping the current page on screen while the next route's loader runs, instead of showing its `loading.tsx` right away (smoother, but you trade away the immediate loading state).

Config is the normal way to turn these on. For a manual override at runtime, the setters are `Toil.setViewTransitions(enabled)` and `Toil.setTransitions(enabled)`:

```tsx
Toil.setViewTransitions(true);
Toil.setTransitions(false);
```

You rarely need the setters; prefer the config keys unless you are toggling an effect dynamically.

## Types

Almost everything on this page is a value on the global `Toil` object, so you call it with no import (`Toil.Link`, `Toil.navigate`, `Toil.useRouter`, and so on). A few of the **types**, though, are not namespaced under `Toil`, so if you want to annotate a prop or a variable you import them from `toiljs/client`:

```tsx
import type {
  LinkProps,
  NavLinkProps,
  NavLinkState,
  NavigateOptions,
  RouterInstance,
} from 'toiljs/client';
```

For example, a component that forwards `Link` props, or a helper typed against the router handle:

```tsx
import type { RouterInstance } from 'toiljs/client';

function logoutThenGo(router: RouterInstance) {
  router.replace('/login');
}
```

## Related

- [Routing](./routing.md): how files become URLs, dynamic params, layouts, and templates.
- [Fetching data](./data-fetching.md): loaders, the typed backend clients, forms, and revalidation.
- [Rendering and SSR](./rendering.md): what renders on the server versus the browser, and how hydration fits with client navigation.

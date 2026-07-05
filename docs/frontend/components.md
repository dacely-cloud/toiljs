# Components

A toiljs frontend is a normal React app, so the components you write are just React components: functions that return JSX, hold state with hooks, and compose however you like. There is no toiljs-specific base class, no decorator, and no registration step. On top of your own components, toiljs ships a small set of ready-made ones on the `Toil` global (an image, a script loader, a form, and a few more) for the jobs a plain React app makes you wire up by hand. This page covers both: how your components fit in, and a reference for every `Toil.*` component.

## Writing your own components

Anything you already know about writing React components applies unchanged. You write ordinary functions, use `useState` / `useEffect` / `useMemo` and any hooks you like, and return JSX:

```tsx
// client/components/Counter.tsx
import { useState } from 'react';

export default function Counter({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start);
  return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>;
}
```

Your reusable components live in `client/components/`, and you import them the normal way from anywhere in `client/`:

```tsx
// client/routes/index.tsx
import Counter from '../components/Counter';

export default function Home() {
  return (
    <main>
      <h1>Welcome</h1>
      <Counter start={10} />
    </main>
  );
}
```

A few things are worth spelling out, because they are the parts that are handled for you rather than by you:

- **Route files must `export default` a component.** A file under `client/routes/` becomes a page only if it default-exports a component (see [Routing](./routing.md)). Files under `client/components/` have no such rule; export them however you please (default or named).
- **The `Toil.*` globals need no import.** `Toil.Link`, `Toil.useParams()`, `Toil.Image`, and everything else on `Toil` are ambient. The compiler generates a `toil-env.d.ts` that types the global, so your editor autocompletes `Toil.` and type-checks it with no `import` line. The same goes for `Server` (the typed backend client) and the `FastMap` / `DataWriter` data utilities. See the [Frontend overview](./README.md) for the whole ambient surface.
- **The JSX runtime is configured for you.** You do not write `import React from 'react'` at the top of every file. The build sets up the automatic JSX runtime, so JSX just works. Import named hooks and types from `react` when you need them (`import { useState, type ReactNode } from 'react'`), but the bare React import for JSX is unnecessary.

In other words, a component in a toiljs app is indistinguishable from a component in any React app. Two things are genuinely special, and both are opt-in.

### Special case 1: components inside an SSR route

If a route opts into server rendering with `export const ssr = true`, its component tree is rendered once at build time into a template, then filled per request on the edge (see [Rendering and SSR](./rendering.md)). For that to work, any part of the JSX that changes per request (a value from the URL, a list from a loader, a block of user HTML) has to be wrapped in one of the [SSR marker primitives](#ssr-marker-primitives) below, or isolated in a `Toil.Island`. Anything you leave unwrapped gets frozen into the template at its build-time value.

You do not have to get this perfect: if an SSR route (or a layout above it) cannot render on the server, toiljs skips SSR for that route at build, prints a warning telling you what to move, and falls back to plain client rendering. So the route still works, it just loses its server first paint until you address the warning.

### Special case 2: importing images and other assets

Importing an image with the `?toil` suffix gives you an object carrying the resolved URL, the intrinsic width and height, and an auto-generated blur placeholder (a `blurDataURL`), ready to hand straight to `Toil.Image`:

```tsx
import hero from './hero.webp?toil';
// hero is { src, width, height, blurDataURL }

<Toil.Image src={hero} alt="Our office" />;
```

Passing the whole object lets `Toil.Image` reserve the correct aspect ratio and paint the blur while the real image loads, with no extra props. See [Images](./images.md) for the full treatment.

Plain asset imports are typed for you as well. A bare `import logo from './logo.svg'` (or `.png`, `.webp`, and so on) resolves to the hashed URL string, and the vite-imagetools query forms (`?url`, `?as=srcset`, `?as=metadata`) are typed too, so you get autocomplete and type-checking on all of them without declaring any modules yourself.

## The toiljs component primitives

These are the components toiljs provides on the `Toil` global. They cover the framework-level jobs a plain React app leaves to you. All are ambient (no import), and all are fully typed.

| Component | What it is | Renders |
| --- | --- | --- |
| `Toil.Image` | Layout-shift-free `<img>` replacement with lazy-load and blur placeholder. | An `<img>` (optionally wrapped in a sizing box). |
| `Toil.Script` | One-time external or inline `<script>` loader with a load strategy. | Nothing (`null`). |
| `Toil.Form` | A `<form>` that runs an action on submit and revalidates loader data. | A `<form>`. |
| `Toil.Slot` | Renders a named parallel-route slot for the current URL. | The slot's route tree, or a fallback. |
| `Toil.Head` | Declarative `<head>` contribution (title, meta, link). | Nothing (`null`). |
| `Toil.Metadata` | Declarative route-style metadata applied from any component. | Nothing (`null`). |

The [SSR marker primitives](#ssr-marker-primitives) (`Toil.Hole`, `Toil.Repeat`, `Toil.RawHtml`, `Toil.attr`, `Toil.Island`) are a separate group, covered in their own section below.

### `Toil.Image`

A drop-in `<img>` replacement that prevents layout shift and lazy-loads by default. You give it `width` and `height` (or `fill`) so it reserves space before the image arrives, it decodes asynchronously, it lazy-loads unless you mark it `priority`, and it can fade in from a blur placeholder. It accepts either a string URL or a `?toil` import object (which auto-fills the size and blur):

```tsx
import hero from './hero.webp?toil';

export default function Home() {
  return (
    <>
      <Toil.Image src={hero} alt="Our office" priority placeholder="blur" />
      <Toil.Image src="/team.jpg" alt="The team" width={800} height={600} />
    </>
  );
}
```

Key props are `src`, `alt` (required, pass `alt=""` for a decorative image), `width` / `height` or `fill`, `priority` (for an above-the-fold hero), and `placeholder` (`'empty'` or `'blur'`). It also accepts any standard `<img>` attribute. This is kept brief on purpose: [Images](./images.md) covers sizing, `fill`, blur placeholders, and how it stops layout shift in full.

### `Toil.Script`

Loads an external or inline `<script>` exactly once for the whole life of the app (even across client-side navigations), and lets you choose when it runs with a `strategy` prop. Use it instead of a hand-written `<script>` tag for third-party snippets like analytics or chat widgets, which a plain `<script>` in a single-page app runs unreliably or twice:

```tsx
// client/layout.tsx
export default function Layout({ children }: { children?: React.ReactNode }) {
  return (
    <div className="app">
      <Toil.Script src="https://cdn.example-analytics.com/analytics.js" />
      {children}
    </div>
  );
}
```

The `strategy` is `afterInteractive` (default), `lazyOnload`, or `beforeInteractive`, and there are `onLoad` / `onReady` / `onError` callbacks. `Toil.Script` renders nothing. See [Scripts](./scripts.md) for the strategies, inline scripts, dedup rules, and the full prop table.

### `Toil.Form`

A `<form>` that submits without reloading the page. On submit it runs your `action` (which receives the form's `FormData`), tracks pending and error state, and on success revalidates the current route's loader data so the page reflects the write. It is the convenient front end of the loader/action data loop:

```tsx
// A guestbook that refreshes its list after a successful sign.
export default function Guestbook() {
  const entries = Toil.useLoaderData<typeof loader>();

  const sign = async (data: FormData) => {
    const author = String(data.get('author'));
    const message = String(data.get('message'));
    await Server.REST.guestbook.sign({ body: new NewMessage(author, message) });
  };

  return (
    <Toil.Form action={sign} resetOnSuccess>
      {({ pending, error }) => (
        <>
          <input name="author" placeholder="Your name" />
          <textarea name="message" />
          <button disabled={pending}>{pending ? 'Signing...' : 'Sign'}</button>
          {error ? <p className="err">Could not sign, try again.</p> : null}
        </>
      )}
    </Toil.Form>
  );
}
```

Pass a render function as the child to read the live submit state: it receives `{ pending, error, data }`, which is how you disable the button while pending or show an error. The props:

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `action` | `(data: FormData) => void \| Promise<void>` | (required) | Runs on submit, receiving the form's `FormData`. May be async. |
| `revalidate` | `RevalidateTarget` | `true` | Which loader data to refetch after a successful submit. `true` is the current route. |
| `onSuccess` | `() => void` | (none) | Called after a successful submit. |
| `onError` | `(error: unknown) => void` | (none) | Called when the action throws. |
| `resetOnSuccess` | `boolean` | `false` | Reset the form fields after a successful submit. |
| `className` | `string` | (none) | Class on the `<form>` element. |
| `children` | `ReactNode` or `(state) => ReactNode` | (none) | Form contents. A function child receives `{ pending, error, data }`. |

For writes that are not form submits (a delete button, a like toggle), reach for the underlying `Toil.useAction` hook instead. Both are covered in [Fetching data](./data-fetching.md).

### `Toil.Slot`

Renders the named parallel-route slot for the current URL. A folder starting with `@` (like `@modal`) under `client/routes/` is a whole second route tree that matches the URL independently of the main page; placing `<Toil.Slot name="modal" />` is where that tree renders. If no slot route matches the current URL, it renders the `fallback` (nothing by default):

```tsx
// client/routes/gallery/layout.tsx
export default function GalleryLayout({ children }: { children?: React.ReactNode }) {
  return (
    <div>
      {children}
      <Toil.Slot name="modal" fallback={null} />
    </div>
  );
}
```

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `name` | `string` | (required) | The slot name: the `@name` directory under `routes/`, without the `@`. |
| `fallback` | `ReactNode` | `null` | Rendered when no slot route matches the current URL. |

Parallel slots and the intercepting routes that fill them (the "click a photo, open it in a modal" pattern) are explained in [Routing](./routing.md).

### `Toil.Head`

A declarative way for any component (a page, a layout, a deep child) to contribute to the document `<head>`: a title, `<meta>` tags, and `<link>` tags. It renders nothing; it just applies its head entries for the lifetime of the component and reverts them on unmount. Entries compose across the tree, with later or deeper ones winning per key:

```tsx
export default function ArticlePage() {
  const post = Toil.useLoaderData<typeof loader>();
  return (
    <>
      <Toil.Head
        title={post.title}
        meta={[
          { name: 'description', content: post.summary },
          { property: 'og:title', content: post.title },
        ]}
        link={[{ rel: 'canonical', href: `https://example.com/blog/${post.id}` }]}
      />
      <article>{/* ... */}</article>
    </>
  );
}
```

`<Toil.Head>` takes `title`, `meta` (an array of `{ name | property, content }` tags), and `link` (an array of `{ rel, href }` tags). The hook form `Toil.useHead(spec)` and the shorthand `Toil.useTitle(title)` do the same job imperatively. See [Metadata and SEO](./metadata.md).

### `Toil.Metadata`

The declarative, convenience-shaped cousin of `Toil.Head`. Instead of raw meta and link arrays, you pass a route-style metadata object (the same shape a route file's `export const metadata` uses), and toiljs expands the convenience fields (`description`, `keywords`, `canonical`, `openGraph`, and so on) into the right tags. It renders nothing, and applies for the component's lifetime. Use it to set metadata from a component that is not itself a route file (a rendered article, a widget):

```tsx
<Toil.Metadata
  title="Our pricing"
  description="Simple, flat pricing for teams of any size."
  openGraph={{ title: 'Pricing', image: 'https://example.com/og/pricing.png' }}
/>
```

Because a route's own `metadata` export is applied last (highest priority), `Toil.Metadata` fills in for routes that declare none and yields to a route that sets the same key. The full field list lives in [Metadata and SEO](./metadata.md).

## SSR marker primitives

These five primitives matter only for routes with `export const ssr = true`. They are how you tell the build which parts of a server-rendered page are dynamic (filled per request) versus static (baked into the template once). On a client-only route they do nothing special, so you never need them unless you opt a route into SSR.

**The mental model.** In the browser these markers are transparent: `<Toil.Hole>` renders its children, `<Toil.Repeat>` maps its rows, `<Toil.RawHtml>` renders a raw-HTML wrapper, and `Toil.attr(id, value)` returns the value unchanged. Your client-side app runs exactly as written. But under the build-time SSR extractor, each marker instead emits a sentinel token that marks an insertion point. The extractor strips those tokens and records their positions, producing a static template with numbered holes. Per request, your compiled backend fills only the hole values, and the edge splices them into the template. Because the static scaffold around each hole is React's own rendering output and the hole values are escaped exactly as React escapes them, the browser hydrates the result byte-for-byte, with no mismatch.

| Marker | Use it for | Shape |
| --- | --- | --- |
| `Toil.Hole` | A single dynamic **text** value. | `<Toil.Hole id="...">{value}</Toil.Hole>` |
| `Toil.Repeat` | A **list**: one row template repeated over an `each` array. | `<Toil.Repeat id="..." each={rows}>{(item, i) => ...}</Toil.Repeat>` |
| `Toil.RawHtml` | A block of **trusted, pre-rendered HTML**. | `<Toil.RawHtml id="..." html={s} as="section" />` |
| `Toil.attr` | A dynamic value in **attribute position** (an `href`, a `class`). | `href={Toil.attr('id', value)}` (a function call) |
| `Toil.Island` | Content that must render **only in the browser** (escape hatch). | `<Toil.Island>{children}</Toil.Island>` |

A few rules that keep the template valid:

- **Every marker needs a stable `id`**, a short name unique within the page. The build maps each id to a numbered slot, so keep the ids constant across builds.
- **`Toil.Repeat` needs at least one row at build time.** It captures that first row as the sub-template for every row, so the build render must see a sample with one or more items. An empty `each` gives it nothing to capture.
- **`Toil.RawHtml` renders inside a wrapper element** (a `<div>` by default, `as="section"` to change the tag), and you own sanitising that HTML, exactly like React's `dangerouslySetInnerHTML`.
- **`Toil.attr` is a function, not an element.** An attribute is not a child node, so it cannot be a JSX element. You call `Toil.attr(id, value)` right where the attribute value goes, and it composes with literal text around it (`` className={`btn ${Toil.attr('kind', d.kind)}`} ``).
- **`Toil.Island` renders nothing on the server and on the first (hydration) render**, then reveals its children after mount. So an island gets no server first paint and no SEO, by design. It is the place for anything that genuinely cannot run on the server (reads `window`, calls `Date.now()`, depends on the live URL).

Here is a compact SSR route wiring several of them together. The title, tag list, and author link all come from the route's `loader`:

```tsx
// client/routes/blog/[id].tsx
export const ssr = true;

export const loader = async ({ params }: Toil.LoaderArgs) => {
  // Illustrative shape: { title, tags, authorUrl }.
  return Server.REST.blog.get({ params: { id: params.id } });
};

export default function BlogPost() {
  const post = Toil.useLoaderData<typeof loader>();
  return (
    <article>
      <h1>
        <Toil.Hole id="title">{post.title}</Toil.Hole>
      </h1>

      {/* A dynamic attribute: call attr() in attribute position. */}
      <a href={Toil.attr('authorUrl', post.authorUrl)}>By the author</a>

      {/* A list: one row template, stamped once per item on the server. */}
      <ul>
        <Toil.Repeat id="tags" each={post.tags}>
          {(tag) => <li key={tag}>{tag}</li>}
        </Toil.Repeat>
      </ul>
    </article>
  );
}
```

For the whole SSR story (the template extraction flow, keeping a route SSR-safe, and the current SSR limitations), see [Rendering and SSR](./rendering.md).

## Related

- [Rendering and SSR](./rendering.md): how SSR routes render, hydrate, and use the marker primitives.
- [Images](./images.md): the full `Toil.Image` reference, blur placeholders, and layout shift.
- [Scripts](./scripts.md): `Toil.Script` strategies, inline scripts, and dedup.
- [Fetching data](./data-fetching.md): `Toil.Form`, `useAction`, loaders, and the typed backend clients.
- [Metadata and SEO](./metadata.md): `Toil.Head`, `Toil.Metadata`, and per-route metadata.
- [Routing](./routing.md): pages, layouts, and the parallel slots `Toil.Slot` renders.

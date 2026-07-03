# Scripts

`Toil.Script` loads an external or inline `<script>` for you, with control over *when* it runs and a guarantee it runs only *once* across your whole app. Use it instead of a hand-written `<script>` tag for third-party snippets (analytics, chat widgets, embeds). It is the toiljs analog of Next.js `next/script`.

## Why not just write a `<script>` tag?

Dropping a raw `<script>` into your JSX is unreliable in a single-page app (an app where the browser loads one HTML shell and JavaScript swaps pages in place, with no full reload). Two problems:

1. **It may not execute.** When React inserts a `<script>` element into the page, the browser does not always run it the way it runs scripts present in the original HTML.
2. **It runs too often.** As the user navigates between routes that both render that script, React can mount it more than once, so an analytics library or a widget initialises twice.

`Toil.Script` fixes both: it injects a real `<script>` into `<head>` so the browser runs it, and it **deduplicates** by a key so a given script executes at most once for the whole life of the app, even across client-side navigations. It renders nothing into your layout.

## The simplest usage: an external script

Give it a `src`. By default it loads once the app is interactive, which is right for most third-party scripts:

```tsx
// client/layout.tsx
import { type ReactNode } from 'react';

export default function Layout({ children }: { children?: ReactNode }) {
  return (
    <div className="app">
      <Toil.Script src="https://cdn.example-analytics.com/analytics.js" />
      {children}
    </div>
  );
}
```

Putting it in the root layout means it loads once for the whole app and stays loaded as the user navigates. For an external script, the dedup key defaults to its `src`, so you never need an `id`.

## Load strategies

The `strategy` prop decides *when* the script is injected, relative to your app becoming interactive:

| Strategy | When it runs | Use it for |
| --- | --- | --- |
| `afterInteractive` (default) | On mount, once the app is running. | Analytics, chat widgets, most third-party scripts. |
| `lazyOnload` | Deferred until the browser is idle, after the page's `load` event. | Low-priority extras (a feedback button, a social embed) that should not compete with the initial render. |
| `beforeInteractive` | As early as possible: injected immediately on first mount. | A script other code depends on immediately. |

One honest caveat about `beforeInteractive`: a toiljs frontend is a client-only single-page app, so there is no server-rendered `<script>` to run before hydration. `beforeInteractive` therefore still runs *after* hydration, just as early and eagerly as possible on the first mount. It is a priority hint, not a true "before the page is interactive" guarantee.

```tsx
<Toil.Script
  src="https://widget.example.com/embed.js"
  strategy="lazyOnload"
/>
```

## Inline scripts

To run a snippet of code instead of loading a URL, put the code in `children` (as a **string**) and give the script an `id`. An inline script has no `src`, so the `id` is what identifies it for dedup, and it is required:

```tsx
<Toil.Script id="init-theme" strategy="beforeInteractive">
  {`document.documentElement.dataset.theme =
      localStorage.getItem('theme') ?? 'light';`}
</Toil.Script>
```

Without an `id` (and no `src`), an inline script has nothing to dedup on, so `Toil.Script` does nothing at all. This is a deliberate no-op, not an error, so remember the `id`.

## Reacting to load

Three optional callbacks let you run code around the script's lifecycle:

```tsx
<Toil.Script
  src="https://widget.example.com/embed.js"
  strategy="lazyOnload"
  onReady={() => {
    // The global the script defines is now available.
    window.MyWidget?.init();
  }}
  onError={(err) => {
    console.warn('widget failed to load', err);
  }}
/>
```

- `onLoad` fires **once**, when an external script finishes loading (or an inline script is inserted).
- `onReady` fires after load **and on every later mount** once the script is already loaded. So if a route that renders the `Toil.Script` is left and revisited, `onReady` runs again, which is the right place to re-initialise a widget.
- `onError` fires if an **external** script fails to load. After an error the script's key is cleared, so a later remount retries the load.

## All props

Read them straight from the source (`src/client/components/Script.tsx`):

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `src` | `string` | (none) | URL of an external script. Omit it when you provide an inline body via `children`. |
| `children` | `string` | (none) | Inline script body. Mutually exclusive with `src`. |
| `strategy` | `'beforeInteractive' \| 'afterInteractive' \| 'lazyOnload'` | `'afterInteractive'` | When to inject the script (see above). |
| `id` | `string` | `src` for external scripts | Stable identity for dedup. **Required** for inline scripts. |
| `type` | `string` | (none) | The `type` attribute, e.g. `'module'` or `'application/json'`. |
| `onLoad` | `() => void` | (none) | Fired once the script has loaded (external) or been inserted (inline). |
| `onReady` | `() => void` | (none) | Fired after load, and on every later mount once the script is already loaded. |
| `onError` | `(error: unknown) => void` | (none) | Fired if an external script fails to load. |

External scripts are injected with `async` set, so they never block other work while downloading.

## Gotchas

- **Inline scripts need an `id`.** No `id` and no `src` means nothing to dedup on, so the component quietly does nothing.
- **Dedup is app-wide and survives navigation.** The same `Toil.Script` rendered on two different routes runs a total of once, keyed by `id` (or `src`). This is the point, but it means you cannot use two copies of the same key to run something twice.
- **Props are read at injection time, and the script re-injects only if its key or strategy changes.** Changing a handler or an inline body *without* changing the `id` will not re-run the script. If you truly need to re-inject a changed inline script, change its `id`.
- **`onReady` versus `onLoad`.** Use `onLoad` for one-time setup that must happen exactly once; use `onReady` for setup that should also run each time a component remounts against an already-loaded script.
- **`beforeInteractive` is not truly before hydration** in a client-only app (see the caveat above). Do not rely on it running before your React tree mounts.
- **`Toil.Script` renders nothing.** It returns `null`, so you can place it anywhere in your component tree; a layout is the usual home for app-wide scripts.

## Related

- [Rendering and SSR](./rendering.md): how the client-only app and its first paint fit together.
- [Metadata and SEO](./metadata.md): for `<head>` tags (title, meta, Open Graph), which is a different job from loading scripts.
- [Frontend overview](./README.md): the `Toil` global and the rest of the client API.

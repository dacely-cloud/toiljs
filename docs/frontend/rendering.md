# Rendering and SSR

This page explains where your pages are built: in the browser, ahead of time at build, or on the server for each request. Getting this right is what makes a page paint fast and rank well.

## The three ways a page can render

A toiljs page can reach the user in three ways. You mostly get all three for free; the only one you opt into per page is edge SSR.

| Mode | Who builds the HTML | When | Good for |
| --- | --- | --- | --- |
| **Client rendering** | The browser, from JavaScript | On every visit | Interactive, per-user pages (a dashboard). The default. |
| **Build-time prerender** | The build, once | When you run `toiljs build` | Baking each route's `<head>` (SEO) into real HTML. Automatic. |
| **Edge SSR** | The edge server, per request | When you set `ssr = true` | A real first-paint page body plus SEO, for landing and content pages. |

Let us define the two words that trip people up:

- **Rendering** means turning your React components into HTML.
- **Hydration** means React attaching to HTML that already exists on the page (from the server) instead of throwing it away and redrawing it. Hydration is what makes a server-rendered page interactive without a flash.

## Client rendering (the default)

By default, toiljs ships a small HTML shell with an empty `<div id="root">`, plus your JavaScript. The browser downloads the JS, React runs, and it builds the page into `#root`. From then on, navigating between pages is pure JavaScript: only the next route's small code chunk and its data are fetched, and the page swaps in place with no reload.

This is fast to navigate and simple to reason about. Its one weakness is the *first* paint: until the JavaScript runs, `#root` is empty. For an app behind a login (a dashboard) that is fine, nobody is trying to index it. For a public landing page, you usually want one of the two server-assisted modes below.

## Build-time prerender (automatic SEO)

Every time you build, toiljs renders each static route once and bakes its resolved `<head>` (title, description, canonical link, Open Graph tags, and so on) into that route's HTML file. This happens for all routes with no extra work from you, and it is driven by the `metadata` you export from a route plus the site-wide `seo` config (see [Metadata and SEO](./metadata.md)).

The payoff: a crawler or a link-preview bot (Slack, Discord, iMessage) that fetches your page sees correct tags immediately, even though it does not run your JavaScript. "View source" on a built page shows the real title and meta tags, not an empty shell.

In production, `toiljs build` writes one prerendered HTML file per route (for example `about/index.html`), and the production static server (`npm start`) serves each route its own prerendered file rather than a single shared shell. That is how each page gets its own metadata in the raw HTML.

Build-time prerender covers the `<head>`. It does not, by itself, fill in the page *body*: for a client-rendered route the body is still built by React in the browser. To get real first-paint body HTML, opt the route into edge SSR.

## Edge SSR (`ssr = true`)

For a route where you want the body content visible on first paint (a marketing page, an article), add one line:

```tsx
// client/routes/index.tsx
export const ssr = true;

export default function Home() {
  return (
    <section className="hero">
      <h1>Welcome</h1>
    </section>
  );
}
```

Now the Dacely edge sends a real, filled-in first paint for that page, and the browser hydrates it. The user sees content immediately, and React takes over without redrawing anything.

### How it works, in brief

toiljs does something clever to keep SSR cheap. It does not re-run React on the server for every request. Instead, at build time it renders the page once into a **template**: the static HTML with the dynamic bits punched out into named holes. Then, per request, your compiled backend fills only the hole values (a small list of "slot 3 = this text"), and the edge splices those values into the pre-baked template. The result is real first-paint HTML produced about as fast as serving a static file.

```mermaid
sequenceDiagram
    participant B as Build
    participant Edge as Dacely edge
    participant U as Browser
    B->>Edge: prebuilt template (HTML with holes) + a coherence hash
    U->>Edge: GET / (ssr route)
    Edge->>Edge: run the wasm render -> small "hole values" list
    Edge->>Edge: splice values into the template
    Edge-->>U: real first-paint HTML
    Note over U: Content is visible immediately
    U->>Edge: fetch JS + route chunk
    Note over U: React hydrates: attaches to the existing HTML
    Note over U: Page is interactive; no redraw, no flash
```

For SSR to hydrate cleanly, the HTML the server produced and the HTML the browser would produce must match byte-for-byte. toiljs guarantees this by escaping hole values exactly as React does and by carrying a hash that ties the running backend to the exact template it was built against. Authoring the server side of an SSR route (the hole markers in the page and the matching `render` function in `server/`) is a deeper topic that lives with the [backend](../backend/README.md). For most pages you only need `export const ssr = true` and to keep the page "SSR-safe" (below).

### Keeping a route SSR-safe

Server rendering happens where there is no browser: no `window`, no `document`, no mouse. So an SSR route (and every layout above it) must render without touching browser-only APIs during that first render. Anything that must run only in the browser (reading `window`, using `Date.now()`, or router hooks that need the live URL) goes inside an **island**, a marker that renders nothing on the server and appears only after hydration.

If a route or one of its layouts throws while rendering on the server, toiljs does not ship a broken page. It **skips SSR for that route at build with a warning** and falls back to plain client rendering. So adding `ssr = true` is always safe: worst case you get client rendering plus a build warning telling you what to move into an island.

### Suspense markers and self-healing hydration

Under the hood the client wraps each route and layout in React `Suspense` boundaries that line up with what the server emitted, so hydration matches. If hydration ever does mismatch (the server HTML and the client's idea of the page disagree), React does the safe thing: it discards the server markup for that part and re-renders it on the client. You get a correct page either way. The cost of a mismatch is a small flash and some wasted work, not a broken page, which is why the guidance above (keep it SSR-safe, put browser-only bits in islands) is about smoothness, not correctness.

## Known SSR limitations

Be aware of these honest gaps as of today:

- **`template.tsx` is not server-rendered.** A `template.tsx` wrapper (the re-mounting cousin of a layout) is not part of the SSR output. A route under one still works: hydration self-heals to client rendering for that part.
- **Parallel slots (`@slot`) are not server-rendered.** Slot content (including intercepted modals) renders on the client after hydration, not in the first paint. Since slots are typically modals and overlays that appear on interaction, this is rarely a problem.
- **Islands have no first paint or SEO.** That is by design: an island is your "client only" escape hatch, so anything inside it is intentionally absent from the server HTML and from what crawlers see.
- **The client loader must reproduce the server's data.** For a hole whose value comes from the request (a query param), the route's client `loader` has to derive the same value the server used, or hydration will re-render that part. If the client cannot reproduce a value, put that content in an island.

## Which mode should I use?

- **Interactive, per-user page** (dashboard, settings): client rendering. Do nothing.
- **Public page that needs correct link previews and titles**: you already have build-time prerender. Do nothing extra.
- **Public page that should also show its content instantly on first load** (landing page, blog post, docs): add `export const ssr = true` and keep it SSR-safe.

## Related

- [Backend overview](../backend/README.md): where the server-side `render` for an SSR route lives.
- [Metadata and SEO](./metadata.md): what gets baked into the `<head>`.
- [Routing](./routing.md): layouts, templates, and slots.
- [Fetching data](./data-fetching.md): loaders and how their data seeds hydration.

<div align="center">

<img src="assets/logo.svg" alt="ToilJS" width="128" height="128" />

# ToilJS

### Everything React forgot to ship.

<sub>Fast by design. Architecture chosen for hyper scale: 50 Gbit/s on commodity hardware.</sub>

<br/>

[![npm](https://img.shields.io/npm/v/toiljs.svg?color=2563ff&label=npm&labelColor=0e1520)](https://www.npmjs.com/package/toiljs)
[![types](https://img.shields.io/badge/types-included-2563ff.svg?labelColor=0e1520)](https://www.typescriptlang.org/)
[![react](https://img.shields.io/badge/react-19-22e3ab.svg?labelColor=0e1520)](https://react.dev/)
[![server](https://img.shields.io/badge/server-WebAssembly-7c3aed.svg?labelColor=0e1520)](#built-for-scale)
[![license](https://img.shields.io/badge/license-Apache--2.0-8b9ab4.svg?labelColor=0e1520)](./LICENSE)

<br/>

<img src="https://img.shields.io/badge/React_19-20232a?style=for-the-badge&logo=react&logoColor=61dafb" alt="React 19" />
<img src="https://img.shields.io/badge/TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
<img src="https://img.shields.io/badge/Vite-646cff?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
<img src="https://img.shields.io/badge/WebAssembly-654ff0?style=for-the-badge&logo=webassembly&logoColor=white" alt="WebAssembly" />

</div>

---

React gives you a renderer and leaves the rest to you: a router, a bundler, data fetching, SEO, an image pipeline, a server. ToilJS is all of it, already wired.

```bash
npx toiljs create my-app
cd my-app
npm run dev
```

Drop a `.tsx` file in `client/routes/` and it is a route: typed, code-split, prefetched, data loaded before render. The `server/` compiles to WebAssembly and self-hosts on uWebSockets. You configured nothing.

## Built for scale

The backend is the point. `server/` is [ToilScript](https://www.npmjs.com/package/toilscript) compiled to a single WebAssembly module (Binaryen), and `toiljs start` self-hosts the app on [hyper-express](https://github.com/kartikk221/hyper-express), backed by [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js), the same core that serves millions of HTTP requests per second.

<div align="center">

![throughput](https://img.shields.io/badge/throughput-50_Gbit%2Fs-2563ff?style=for-the-badge)
![requests](https://img.shields.io/badge/requests-millions%2Fsec-7c3aed?style=for-the-badge)
![compute](https://img.shields.io/badge/compute-native_WASM-22e3ab?style=for-the-badge)
![transport](https://img.shields.io/badge/transport-HTTP%2F3_+_WebTransport-654ff0?style=for-the-badge)

</div>

- **WebAssembly compute.** Your server logic runs as native-speed WASM, not interpreted JS.
- **Binary on the wire.** The client and server share `BinaryWriter` / `BinaryReader` and `FastMap` / `FastSet`, so you move bytes, not JSON.
- **HTTP/3 and WebTransport** over QUIC, low-latency streaming without the TCP head-of-line tax.
- **Built for 50 Gbit/s on commodity hardware** and millions of requests per second, not toy demos.

```ts
// server/index.ts
export function add(a: i32, b: i32): i32 {
    return a + b;
}
```

## On by default

Every one of these works the moment you run `create`. No plugins to install, no config to write:

- **Build-time SEO for an SPA**: prerendered `<head>`, `robots.txt`, `sitemap.xml`, `llms.txt`
- **AI-crawler rules**: per-bot `robots.txt` plus `llms.txt`, one switch
- **Image optimization on**: imports and plain `<img>` become resized webp
- **Fonts preloaded** at build
- **Typed routes**: `href` and `params` checked against your real files
- **Loaders and mutations** with caching and revalidation, no data library, no `useEffect` fetching
- **Parallel and intercepting routes** for modals and dashboards
- **Instant navigation** and **animated view transitions**
- **WebAssembly backend** on uWebSockets, with **binary IO** on both sides

Anywhere else, that is a dozen packages and their config. Most teams wire three and ship the rest half-done.

## AI-ready

ToilJS treats AI crawlers as first-class. Turn on SEO and the build emits an `llms.txt` describing your site for LLMs, and a `robots.txt` with explicit rules for the AI bots, allow or block GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, anthropic-ai, Google-Extended, PerplexityBot, CCBot, Applebot-Extended, Bytespider, Amazonbot, and Meta-ExternalAgent, with one switch.

```ts
seo: { llms: { instructions: 'Docs live at /docs.' }, robots: { ai: 'disallow' } }
```

That one line produces a real `robots.txt`:

```
User-agent: *
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Google-Extended
Disallow: /

Sitemap: https://example.com/sitemap.xml
```

The `toiljs create` wizard can also scaffold assistant files (CLAUDE.md, AGENTS.md, Cursor and Copilot configs) so your repo is ready for coding agents on day one.

## Everything, at a glance

|  |  |
| --- | --- |
| **Routing** | File-based. Dynamic, catch-all, optional catch-all, route groups, nested layouts, templates, parallel slots, and intercepting routes. Every `href` and `params` is typed. |
| **Data** | A `loader` resolves before render. `useAction` / `<Form>` write then revalidate. Per-route caching. No fetch waterfalls. |
| **SEO** | Per-route metadata baked into static HTML, plus `robots.txt`, `sitemap.xml`, `llms.txt`, OpenGraph, Twitter, JSON-LD, canonical, theme-color, early hints. |
| **Assets** | Imported images compressed to webp and resized. Fonts preloaded. React split for caching. Build logs what it saved. |
| **Realtime** | Built-in WebSocket channels: `connectChannel` / `useChannel`. WebTransport over HTTP/3. |
| **DX** | HMR, instant navigation, view transitions, typed routes, and a dev error overlay. |
| **Server** | ToilScript compiled to WebAssembly, self-hosted on uWebSockets with HTTP/3. Binary IO built in. |
| **Tooling** | Strict TypeScript, ESLint, and Prettier, configured and enforced out of the box. Tailwind v4 optional. |

## Routing

The filesystem is the router.

| File or folder | Route |
| --- | --- |
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `blog/[id].tsx` | `/blog/:id` |
| `docs/[...slug].tsx` | catch-all |
| `docs/[[...slug]].tsx` | optional catch-all |
| `(marketing)/about.tsx` | route group, adds no URL segment |
| `layout.tsx` | wraps the segment, persists across navigation |
| `template.tsx` | a layout that re-mounts on every navigation |
| `loading.tsx` | Suspense fallback while the route and its data load |
| `error.tsx` | error boundary for the segment |
| `global-error.tsx` | catches errors in the root layout itself |
| `404.tsx` | not-found page |
| `@modal/...` | parallel slot, placed with `<Toil.Slot name="modal" />` |
| `@modal/(.)photo/[id]` | intercepting route: modal on soft nav, full page on reload |

Navigation comes with it:

- **`<Toil.Link>`** and **`<Toil.NavLink>`** (active class + `aria-current`), with `href` checked against your real routes.
- **`navigate` / `back` / `forward` / `refresh`**, plus **`useRouter`**, **`useNavigate`**, **`useLocation`**, **`usePathname`**, **`useParams`**, **`useSearchParams`**, **`useNavigationPending`**.
- **Hover and viewport prefetching**, so chunks are warm before you click.
- **Scroll restoration** on back/forward, scroll-to-`#hash`, and scroll-to-top on new routes.
- **Instant navigation**: visited pages render synchronously, no flash.
- **View transitions** (`client.viewTransitions: true`) for animated page changes, respecting `prefers-reduced-motion`.

## Data

Read with a `loader`, write with an action. Both keep the UI in sync without manual refetching.

```tsx
export const loader = async ({ params }: Toil.LoaderArgs) => fetchPost(params.id);
export const revalidate: Toil.Revalidate = 10; // reuse for 10s, false = forever, omit = every nav

function SaveButton({ title }: { title: string }) {
    const save = Toil.useAction((t: string) => api.save(t), { revalidate: true });
    return (
        <button disabled={save.pending} onClick={() => void save.run(title)}>
            {save.pending ? 'Saving' : 'Save'}
        </button>
    );
}
```

- **`loader`** resolves in parallel with the route chunk; the page suspends until ready (its `loading.tsx` shows).
- **`useLoaderData(loader)`** is typed straight from the loader, no generics.
- **`revalidate`** sets the cache policy per route; **`router.revalidate()`** / **`revalidate(href)`** bust it after a mutation.
- **`useAction`** and **`<Toil.Form>`** track pending and error state and revalidate on success.

## Components

Zero-import, on the `Toil` global:

- **`Image`** drops in for `<img>`: reserves space (no layout shift), lazy-loads, async-decodes, `priority` for the LCP image, `fill` + `objectFit`, optional blur placeholder.
- **`Script`** loads external or inline scripts with a `strategy` (`afterInteractive` / `lazyOnload` / `beforeInteractive`), deduplicated so a script never runs twice.
- **`Form`** submits to an action without a reload, revalidates on success, exposes pending state, optionally resets fields.
- **`Slot`** renders a parallel `@slot` route, the basis for modal overlays.
- **`Head`** / **`useHead`** / **`useTitle`** set the title and `<meta>` / `<link>` tags imperatively and compose across the tree.

## Head and SEO

A single-page app serves an empty shell. ToilJS pre-renders each route's `<head>` at build, so Google, Facebook, Discord, Slack, and the AI crawlers see real per-page tags without running your JavaScript.

```ts
// toil.config.ts
export default defineConfig({
    client: {
        seo: {
            url: 'https://example.com',
            title: 'My App',
            openGraph: { siteName: 'My App', type: 'website', image: '/og.png' },
            twitter: { card: 'summary_large_image' },
            jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite' },
            themeColor: '#2563ff', // also the Discord / Slack embed accent
            preconnect: ['https://cdn.example.com'],
            robots: { ai: 'allow' },
        },
    },
});
```

- **Per-route `metadata`** (or `generateMetadata` derived from the loader's data) wins per page over layout defaults.
- **Static prerender** writes a `<route>/index.html` for every static route with that route's head baked in.
- **`robots.txt`**, **`sitemap.xml`**, and **`llms.txt`** generated together.
- Full **OpenGraph** (image alt/width/height/type, locale), **Twitter card**, **`fb:app_id`**, **JSON-LD**, **canonical**, **theme-color**, and **`preconnect` / `dns-prefetch`** early hints.
- Output is **XSS-hardened**: attribute values and inline JSON-LD are escaped so injected data can't break out.

## Build and assets

ToilJS owns Vite and does the boring optimization for you. The build tells you what it did:

```
$ npm run build
  ✓ optimized 3 images
  client/hero.png
    → images/hero.webp   148.0 kB → 19.3 kB  -87%
  ✓ preloaded 2 fonts
    → fonts/inter-latin.woff2   24.10 kB
```

- **Images** (`vite-imagetools` + `sharp`): every imported raster is compressed to webp, resize and reformat with `?w=400;800&format=webp&as=srcset`. The build logs the savings.
- **Fonts**: bundled `@font-face` fonts get a `<link rel="preload">` so text paints sooner, also logged.
- **Chunking**: React is split into its own long-lived chunk; assets land in tidy `images/`, `fonts/`, and `css/` folders.
- **Node polyfills** (`Buffer`, `global`, `process`) for libraries that expect them.
- **Styling**: plain CSS out of the box, with Sass, Less, Stylus, and Tailwind v4 a `toiljs configure` away.

## Realtime

A typed WebSocket channel to the server, built in.

```tsx
const messages = Toil.useChannel<Message>('/chat');
```

`connectChannel` / `useChannel` / `resolveChannelUrl` handle connection, reconnection, and message decoding.

## Binary IO

The same primitives on both sides of the wire, available as globals (and `toiljs/io`): `BinaryWriter`, `BinaryReader`, `FastMap`, `FastSet`. Move structured data without the JSON tax.

## Tooling is the standard

ToilJS sets the toolchain so nobody argues about it. Strict TypeScript, ESLint, and Prettier come configured and enforced from the first commit. New apps are wired automatically, nothing to set up, nothing to copy, nothing to bikeshed. This is the standard, not a suggestion.

## CLI

```
toiljs create [name]   scaffold a new app (styling, AI files, package manager)
toiljs dev             dev server with HMR
toiljs build           production build
toiljs start           self-host the build (hyper-express / uWebSockets)
toiljs configure       toggle styling, image, font, and SEO features
toiljs doctor          diagnose project setup and dependencies (--json for CI)
```

## Tech

<div align="center">

<img src="https://img.shields.io/badge/React_19-20232a?style=for-the-badge&logo=react&logoColor=61dafb" alt="React 19" />
<img src="https://img.shields.io/badge/TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
<img src="https://img.shields.io/badge/Vite-646cff?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
<img src="https://img.shields.io/badge/WebAssembly-654ff0?style=for-the-badge&logo=webassembly&logoColor=white" alt="WebAssembly" />
<img src="https://img.shields.io/badge/sharp-99cc00?style=for-the-badge&logo=sharp&logoColor=white" alt="sharp" />
<img src="https://img.shields.io/badge/ESLint-4b32c3?style=for-the-badge&logo=eslint&logoColor=white" alt="ESLint" />
<img src="https://img.shields.io/badge/Prettier-f7b93e?style=for-the-badge&logo=prettier&logoColor=black" alt="Prettier" />
<img src="https://img.shields.io/badge/Tailwind_v4-06b6d4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind v4" />

</div>

React 19, TypeScript, Vite, ToilScript (compiles to WebAssembly, on Binaryen), hyper-express + uWebSockets.js, vite-imagetools + sharp, ESLint (typescript-eslint, react-hooks, react-refresh, @eslint-react), Prettier, Tailwind v4 (optional).

## One file does a lot

```tsx
// client/routes/posts/[id].tsx  ->  /posts/:id
interface Post {
    title: string;
}

export const metadata: Toil.Metadata = { title: 'Post' };       // SEO, baked into the HTML at build

export const loader = async ({ params }: Toil.LoaderArgs): Promise<Post> => {
    const res = await fetch(`/api/posts/${params.id}`);         // runs before render, no useEffect
    return res.json();
};

export default function PostPage() {
    const post = Toil.useLoaderData(loader);                    // typed Post, no generics
    return (
        <article>
            <h1>{post.title}</h1>
            <Toil.Link href="/posts">All posts</Toil.Link>      {/* href is type-checked */}
        </article>
    );
}
```

No imports. `Toil` is a fully-typed global, tree-shaken at build. The page renders with its data already loaded.

## Start

```bash
npx toiljs create my-app
```

Everything in this README is already on. You just build the app.

<div align="center"><br/><sub>Apache-2.0</sub></div>

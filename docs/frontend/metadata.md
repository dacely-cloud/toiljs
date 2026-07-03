# Metadata and SEO

Metadata is the information in a page's `<head>`: its title, its description, and the tags that control how it looks when shared on social media or listed by a search engine. toiljs lets you set all of it per route, and bakes it into real HTML so crawlers see it even without running your JavaScript.

## The quick version

For most pages, `export const metadata` from the route file. That is it:

```tsx
// client/routes/features/seo.tsx
export const metadata: Toil.Metadata = {
  title: 'useReducer | React Hooks',
  description: 'Manage complex state transitions with a reducer function.',
  keywords: ['react', 'hooks', 'useReducer'],
  canonical: 'https://example.com/features/seo',
  openGraph: {
    title: 'useReducer | React Hooks',
    description: 'Manage complex state transitions with a reducer.',
    type: 'website',
  },
};

export default function SeoDemo() {
  return <main><h1>Route metadata</h1></main>;
}
```

The router applies this before the page paints (so the tab title updates with no flicker), and the build bakes it into the page's static HTML so search engines and link-preview bots read it directly.

## The `Metadata` fields

`Toil.Metadata` maps friendly fields onto the right `<meta>` and `<link>` tags for you:

| Field | Becomes |
| --- | --- |
| `title` | The document `<title>`. |
| `description` | `<meta name="description">`. |
| `keywords` | `<meta name="keywords">` (an array is joined with commas). |
| `canonical` | `<link rel="canonical">`. |
| `robots` | `<meta name="robots">`, e.g. `'noindex, nofollow'`. |
| `themeColor` | `<meta name="theme-color">` (the accent color of some link embeds). |
| `openGraph` | The `og:*` tags (title, description, type, url, image, siteName). |
| `meta` | Escape hatch: extra raw `<meta>` tags. |
| `link` | Escape hatch: extra raw `<link>` tags. |

Open Graph (the `og:*` tags) is the shared standard that Facebook, Discord, Slack, LinkedIn, and iMessage read to build a link preview card. Set `openGraph.image` (an absolute URL, ideally at least 1200 by 630 pixels) to control the preview picture:

```tsx
export const metadata: Toil.Metadata = {
  title: 'Our launch',
  description: 'Read the announcement.',
  openGraph: {
    title: 'Our launch',
    description: 'Read the announcement.',
    type: 'article',
    image: 'https://example.com/og/launch.png',
  },
};
```

## Dynamic metadata: `generateMetadata`

When the title depends on the URL or on fetched data (a blog post's title, a product name), export `generateMetadata` instead of a static object. It receives the route params, the query, and the route loader's data, and returns a `Metadata`:

```tsx
// client/routes/blog/[id].tsx
export const generateMetadata: Toil.GenerateMetadata = ({ params }) => ({
  title: `Blog post ${params.id}`,
  description: `Reading blog post ${params.id}.`,
});
```

Now `/blog/42` sets the tab to "Blog post 42". If your route has a `loader`, its data is passed in as `data`, so you can title a page from the content it loaded:

```tsx
export const loader = async ({ params }: Toil.LoaderArgs) =>
  Server.REST.blog.get({ params: { id: params.id } });

export const generateMetadata: Toil.GenerateMetadata = ({ data }) => ({
  title: data.title,
  description: data.excerpt,
});
```

## Imperative and stateful head: `useHead`, `useTitle`, `<Head>`

Sometimes the head depends on component state, not on the route. For that, set it from inside a component with `Toil.useHead`, `Toil.useTitle`, or the declarative `<Toil.Head>`. These apply for the component's lifetime and revert when it unmounts:

```tsx
export default function HeadDemo() {
  const [count, setCount] = useState(0);

  // The tab title updates every render as count changes.
  Toil.useTitle(`Clicked ${count} times`);

  Toil.useHead({
    meta: [{ name: 'description', content: `Clicked ${count} times.` }],
  });

  return <button onClick={() => setCount((c) => c + 1)}>Clicked {count}</button>;
}
```

The declarative form renders nothing and is equivalent:

```tsx
<Toil.Head
  title="Blog"
  meta={[{ name: 'description', content: 'Latest posts' }]}
/>
```

Use `useHead`/`useTitle` when the value is dynamic or lives in component state; use the `metadata` export when it is a static property of the route.

### Applying a whole `Metadata` object from a component: `useMetadata`

`useHead` takes raw `<meta>` and `<link>` tags. When you would rather pass the same friendly `Metadata` shape you use in a route's `metadata` export (with `title`, `openGraph`, `keywords`, and the rest), use `Toil.useMetadata` from inside any component. It applies for that component's lifetime and reverts on unmount, exactly like `useHead`. This is the tool for content that is not itself a route file: a reusable article component, a widget, a search-result view.

```tsx
export default function Article({ post }: { post: Post }) {
  Toil.useMetadata({
    title: post.title,
    description: post.excerpt,
    openGraph: { type: 'article', title: post.title, image: post.cover },
  });

  return <article>{/* ... */}</article>;
}
```

There is a declarative twin, `<Toil.Metadata title="..." openGraph={...} />`, which renders nothing (the component-level counterpart of a route's `metadata` export). A route's own `metadata` export is still merged last (highest priority), so it wins for the keys it sets, and `useMetadata` fills in for routes that declare none.

> **Advanced.** Under the hood, `Toil.resolveMetadata(metadata)` is the pure function that expands a `Metadata` object into concrete `<meta>`/`<link>` tags (a `HeadSpec`), and `Toil.mergeHead(specs)` is the pure merge that resolves all active head contributions into the final result (the last `title` wins, `meta` dedupes by `name`/`property`, `link` by `rel` + `href`). You rarely call these directly, but they are exported for tooling and tests.

## How the pieces combine

Multiple things can contribute to the head at once: your site-wide defaults, a layout, and the page. They merge by key, with a clear priority. Later, more specific contributions win per key, and anything left unset falls through to a broader default:

```mermaid
flowchart TB
    A["Site-wide defaults<br/>client.seo config"] --> M{"merge by key"}
    B["Root layout &lt;Toil.Head&gt;<br/>(fallback title, description)"] --> M
    C["Component useHead / useTitle"] --> M
    D["Route metadata / generateMetadata<br/>(highest priority)"] --> M
    M --> R["The page's final &lt;head&gt;"]
```

- A **root layout** is the natural home for site-wide fallbacks (a default title and description for any page that sets none):

  ```tsx
  // client/layout.tsx
  <Toil.Head
    title="My Site"
    meta={[{ name: 'description', content: 'Planet-scale apps.' }]}
  />
  ```

- A **route's `metadata`** overrides those defaults for the keys it sets, while the layout still fills in everything the route leaves unset. So a page can set just a `title` and inherit the site description.

The rule of thumb: put fallbacks in the layout, put the specifics on the route.

## Build-time SEO for the whole site

Beyond per-route metadata, toiljs generates site-level SEO assets at build time from a `client.seo` block in `toil.config.ts`. These are baked into the HTML `<head>` and written as files, so JavaScript-less crawlers and AI bots get correct information:

```ts
// toil.config.ts
import { defineConfig } from 'toiljs/compiler';

export default defineConfig({
  client: {
    seo: {
      url: 'https://example.com',        // required for canonical/OG urls, sitemap
      title: 'My Site',
      description: 'Planet-scale apps from a single repo.',
      openGraph: {
        type: 'website',
        siteName: 'My Site',
        image: 'https://example.com/og.png',
      },
      twitter: { card: 'summary_large_image', site: '@mysite' },
      robots: { ai: 'allow' },           // allow or disallow known AI crawlers
      llms: { instructions: 'Docs live at /docs.' },
      jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite', name: 'My Site' },
    },
  },
});
```

From this one block, the build:

- bakes the default `<title>`, `description`, Open Graph, Twitter card, and JSON-LD structured data into every page's HTML;
- overlays each route's own `metadata` on top and points that route's canonical and `og:url` at its own URL;
- generates `robots.txt` (with directives for AI crawlers like GPTBot and ClaudeBot), `sitemap.xml` (from your static routes), and `llms.txt` (a guidance file for AI crawlers).

You get correct, per-page SEO in the raw HTML with almost no manual tag writing. Confirm it with "View source" on a built page: the real title and tags are right there, not injected later by JavaScript.

### The complete `client.seo` reference

Every field `client.seo` accepts is below. All of them are optional, and everything you set becomes a baked-in `<head>` tag or a generated file (`robots.txt`, `sitemap.xml`, `llms.txt`).

**Top level:**

| Field | Type | What it does |
| --- | --- | --- |
| `url` | `string` | Absolute site base URL, e.g. `'https://example.com'`. Unlocks `sitemap.xml`, the canonical `<link>`, and absolute Open Graph / Twitter URLs. |
| `title` | `string` | Default document `<title>`. |
| `description` | `string` | Default `<meta name="description">`. |
| `robotsMeta` | `string` | Default `<meta name="robots">`, e.g. `'index, follow'`. (This is the meta tag; the `robots` field below is the separate `robots.txt` file.) |
| `themeColor` | `string` | `<meta name="theme-color">`, also the accent color of some Discord / Slack link embeds. |
| `openGraph` | object | Open Graph (`og:*`) defaults, see below. |
| `twitter` | object | Twitter / X card, see below. |
| `facebook` | `{ appId?: string }` | `appId` renders `<meta property="fb:app_id">`. Open Graph covers the rest of the Facebook card. |
| `preconnect` | `string[]` | Origins to `<link rel="preconnect">` (early connection hints). |
| `dnsPrefetch` | `string[]` | Origins to `<link rel="dns-prefetch">`. |
| `jsonLd` | object or object[] | JSON-LD structured data injected as `<script type="application/ld+json">`. Pass an array to include several nodes (they are serialized into one `<script>` as a JSON array). |
| `robots` | object or `false` | `robots.txt` generation, see below. `false` skips the file. |
| `sitemap` | `boolean` | `sitemap.xml` generation. On by default when `url` is set; `false` skips it. |
| `llms` | object or `boolean` | `llms.txt` (AI-crawler guidance) generation. `false` skips it, `true` or an object configures it. |

**`openGraph`** (the `og:*` tags; `title` and `description` fall back to the top-level values):

| Field | Type | Renders |
| --- | --- | --- |
| `title` | `string` | `og:title` |
| `description` | `string` | `og:description` |
| `type` | `string` | `og:type`, e.g. `'website'` or `'article'` (defaults to `'website'`). |
| `siteName` | `string` | `og:site_name` |
| `locale` | `string` | `og:locale`, e.g. `'en_US'`. |
| `image` | `string` | `og:image`, the preview picture (absolute URL, ideally at least 1200 by 630 pixels). |
| `imageAlt` | `string` | `og:image:alt` |
| `imageWidth` | `number` | `og:image:width` in pixels (lets Facebook / LinkedIn render without a re-fetch). |
| `imageHeight` | `number` | `og:image:height` in pixels. |
| `imageType` | `string` | `og:image:type`, e.g. `'image/png'`. |

**`twitter`** (the Twitter / X card; unset fields fall back to the Open Graph or top-level values):

| Field | Type | Renders |
| --- | --- | --- |
| `card` | `string` | `twitter:card`: `'summary'` or `'summary_large_image'` (defaults by whether an image is present). |
| `site` | `string` | `twitter:site`, the site's `@handle`. |
| `creator` | `string` | `twitter:creator`, the author's `@handle`. |
| `title` | `string` | `twitter:title` (falls back to `openGraph.title` / `title`). |
| `description` | `string` | `twitter:description` (falls back to `openGraph.description` / `description`). |
| `image` | `string` | `twitter:image` (falls back to `openGraph.image`). |
| `imageAlt` | `string` | `twitter:image:alt` (falls back to `openGraph.imageAlt`). |

**`robots`** (the `robots.txt` file; set `robots: false` to skip it):

| Field | Type | What it does |
| --- | --- | --- |
| `rules` | `RobotsRule[]` | Custom `User-agent` groups. Each rule is `{ userAgent?: string \| string[], allow?: string[], disallow?: string[] }`. Defaults to one group allowing everything (`User-agent: *`, `Allow: /`). |
| `ai` | `'allow'` or `'disallow'` | How to treat known AI crawlers (GPTBot, ClaudeBot, Google-Extended, and more). Default `'allow'`. |
| `sitemap` | `string` | Explicit `Sitemap:` line (defaults to `<url>/sitemap.xml` when `url` is set). |

**`llms`** (the `llms.txt` guidance file; set `llms: false` to skip it, `llms: true` for defaults):

| Field | Type | What it does |
| --- | --- | --- |
| `title` | `string` | The file's heading (falls back to `seo.title`). |
| `summary` | `string` | The summary blockquote (falls back to `seo.description`). |
| `instructions` | `string` | Free-form guidance for AI / LLM crawlers. |
| `pages` | `LlmsPage[]` | Key pages, each `{ title: string, url: string, description?: string }`. Defaults to the site's static routes. |

A fully worked config touching most of these fields:

```ts
// toil.config.ts
import { defineConfig } from 'toiljs/compiler';

export default defineConfig({
  client: {
    seo: {
      url: 'https://example.com',           // base URL: unlocks sitemap, canonical, absolute OG/Twitter URLs
      title: 'My Site',                      // default <title>
      description: 'Planet-scale apps.',     // default <meta name="description">
      robotsMeta: 'index, follow',           // default <meta name="robots">
      themeColor: '#0b0b0f',                 // <meta name="theme-color">

      openGraph: {
        type: 'website',                     // og:type
        siteName: 'My Site',                 // og:site_name
        locale: 'en_US',                     // og:locale
        image: 'https://example.com/og.png', // og:image (absolute, ideally 1200x630)
        imageAlt: 'My Site preview',         // og:image:alt
        imageWidth: 1200,                    // og:image:width
        imageHeight: 630,                    // og:image:height
        imageType: 'image/png',              // og:image:type
      },

      twitter: {
        card: 'summary_large_image',         // twitter:card
        site: '@mysite',                     // twitter:site
        creator: '@ada',                     // twitter:creator
        // title / description / image / imageAlt fall back to openGraph + top level
      },

      facebook: { appId: '1234567890' },     // <meta property="fb:app_id">

      preconnect: ['https://cdn.example.com'],        // <link rel="preconnect">
      dnsPrefetch: ['https://analytics.example.com'], // <link rel="dns-prefetch">

      robots: {
        ai: 'allow',                         // known AI crawlers: 'allow' | 'disallow'
        rules: [                             // custom User-agent groups for robots.txt
          { userAgent: '*', allow: ['/'], disallow: ['/admin'] },
        ],
        // sitemap: 'https://example.com/sitemap.xml', // explicit line (auto from url otherwise)
      },
      sitemap: true,                         // generate sitemap.xml (on by default when url is set)

      llms: {                                // llms.txt (AI-crawler guidance)
        title: 'My Site',
        summary: 'Planet-scale apps from a single repo.',
        instructions: 'Docs live at /docs.',
        // pages: [{ title: 'Docs', url: 'https://example.com/docs', description: 'Guides' }],
      },

      jsonLd: [                              // array = several nodes in one <script>
        { '@context': 'https://schema.org', '@type': 'WebSite', name: 'My Site' },
        { '@context': 'https://schema.org', '@type': 'Organization', name: 'My Site' },
      ],
    },
  },
});
```

## Per-request titles on server-rendered pages

For a page that is server-rendered (`export const ssr = true`), the backend can set a fresh `<title>` for each individual request (for example, a search page titled with the query the visitor typed). The edge splices that per-request title into the document before sending it, so the correct title is in the very first byte of HTML. This is a server-side API used in your `render` function; the frontend `metadata` above covers everything else. See [Rendering and SSR](./rendering.md) for how SSR pages are assembled.

## Gotchas

- **`generateMetadata` needs the data available.** It runs with the route loader's data, so it can only use what the loader returns. Fetch what the title needs in the loader.
- **Open Graph images must be absolute URLs.** A relative `/og.png` will not resolve for an external crawler. Use the full `https://...` URL (set `seo.url` and it can build them for you).
- **`seo.url` unlocks the site-level assets.** `sitemap.xml`, canonical links, and absolute OG urls all need the site's base `url`. Set it once in the config.
- **Static export vs runtime.** The `metadata` export is baked into HTML at build (great for crawlers) *and* applied at runtime on navigation. `useHead` runs only at runtime; a crawler that does not execute JS will not see it. Prefer the `metadata` export for anything that matters for SEO.

## Related

- [Rendering and SSR](./rendering.md): how the baked head and SSR title reach the browser.
- [Images](./images.md): producing the `og:image` for share previews.
- [Routing](./routing.md): where `metadata` and `generateMetadata` live in a route file.
- [Configuration](../concepts/config.md): the full `toil.config.ts` reference.

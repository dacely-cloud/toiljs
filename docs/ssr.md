# Server-side rendering (SSR)

toiljs server-renders a route by splitting it into two halves that the build
keeps coherent:

- **the template**, the HTML shell with the dynamic bits punched out (named
  *holes*). It is React's own `renderToStaticMarkup` output with the holes
  removed, precompiled at build time and held (mmap'd) by the edge.
- **the values**, the hole values for one request (text, attributes, repeated
  rows, headers, status). The wasm guest's `render` entrypoint returns *only*
  these. The edge splices them into the template.

A 32-byte template **hash** travels with the values so the edge can reject a
guest that was compiled against a different template than the one deployed.

This split is the whole point. The guest never re-runs React and never emits the
static page bytes, it stamps a tiny `(slot_id, kind, value)` list, so the wasm
stays small and a request is served about as fast as a static file, while still
delivering real first-paint HTML and SEO. The browser then hydrates the spliced
markup in place with no flash and no client re-render, because the holes are
escaped exactly the way React escapes them, so the bytes match.

This page is about server-rendered HTML. JSON / binary API endpoints use
[Routing](./routing.md) and `@rest` (see [Server](./server.md)) instead.

The running example throughout is the basic example's `/hello` route:

- `examples/basic/client/routes/hello.tsx`, the route (`ssr = true`, holes, loader)
- `examples/basic/server/SsrHelloRender.ts`, the server `render` + `Ssr.register`
- `examples/basic/server/_ssr/hello.slots.ts`, the generated `Slot` + `HASH` (gitignored, never hand-edited)

---

## 1. Authoring an SSR route

Opt a route in with `export const ssr = true`. At build time toiljs renders the
page ONCE (under its real layout chain, with sample loader data) into the
template, generates the route's typed `Slot` module, and writes the template
manifest the edge serves. Routes without `ssr = true` are untouched and render
purely on the client as before.

Mark the dynamic bits with the four hole markers from `toiljs/client`. They are
**transparent in the browser**, `<Hole>` renders its children, `<Repeat>`
renders `each.map(...)`, `<RawHtml>` renders a `dangerouslySetInnerHTML`
wrapper, `<Island>` renders its children, so the same component is your normal
client UI. Only the build extractor and the server `render` treat them
specially.

```tsx
import { Hole, Island, RawHtml, Repeat, useLoaderData } from 'toiljs/client';

export const ssr = true;

export const loader = ({ params }: { params: Record<string, string> }) => ({
  name: params.name ?? 'world',
  blurbHtml: 'Rendered at the <strong>edge</strong>.',
  services: [{ name: 'record', region: 'us-east' }],
});

export default function Hello() {
  const d = useLoaderData<typeof loader>();
  return (
    <section className="hello">
      <h1>Hello, <Hole id="name">{d.name}</Hole>!</h1>

      <p><RawHtml id="blurb" html={d.blurbHtml} as="span" /></p>

      <ul>
        <Repeat id="services" each={d.services}>
          {(s) => (
            <li>
              <strong><Hole id="svcName">{s.name}</Hole></strong>
              <span className="hello-region"><Hole id="svcRegion">{s.region}</Hole></span>
            </li>
          )}
        </Repeat>
      </ul>

      <Island>
        <p>Hydrated at {new Date().toLocaleTimeString()}.</p>
      </Island>
    </section>
  );
}
```

### The loader at build time

The build calls your `loader` once with synthesized sample params to obtain
representative data, then renders the page with it. Only the **shape** of the
data matters at build time, it drives which holes exist and (for `<Repeat>`)
captures the row sub-template. The real per-request values come from the
**server** `render`, not from this loader. Note in particular that `<Repeat>`
needs the sample to have **at least one row** so the build can capture the row
markup; an empty array at build time leaves nothing to stamp.

### The four hole markers

| Marker | Prop(s) | Server (build + render) | Browser |
| --- | --- | --- | --- |
| `<Hole id>` | `id` | a text insertion point; the guest fills it with the **escaped** value | renders `children` |
| `<RawHtml id html as?>` | `id`, `html`, `as?` (wrapper tag, default `div`) | emits `<as>…</as>`; the guest fills the inner HTML **verbatim** (you sanitize) | `<as dangerouslySetInnerHTML>` |
| `<Repeat id each>` | `id`, `each`, child `(item, index) => node` | captures the **one** row sub-template; the guest stamps it per item and concatenates | renders `each.map(children)` |
| `<Island>` | `children` | renders **nothing** (empty in the server HTML) | renders `children` |

`<RawHtml>` always needs a host element so the server and client DOM agree; that
is the `as` wrapper (defaults to `div`). The captured `<as>` tag is part of the
template, only its inner HTML is a hole.

### Attribute holes (`attr()`)

An attribute value is not a child node, so it cannot be a JSX marker element.
Use the `attr(id, value)` helper from `toiljs/client` in attribute position
instead:

```tsx
import { attr } from 'toiljs/client';

<a href={attr('profileUrl', d.url)} class={attr('cls', d.cls)}>…</a>
```

Browser: `attr` returns `value` unchanged. Build: it emits an `attr` hole at the
attribute's byte offset (stripping to an empty value in the `.tmpl`). The server
`render` fills it with `v.setAttr(Slot.profileUrl, url)` (React-escaped, the same
as `setText`), and the host splices it between the quotes. It composes with
literal text in the same attribute (`` class={`btn ${attr('x', v)}`} ``).

### SSR-safe routes (and `<Island>`)

For hydration to be byte-clean, the route **and the layouts above it** must
render under static markup: use the hole markers and `useLoaderData`, and put
anything that needs router hooks (`useRouter`, `usePathname`, …) or browser-only
APIs (`window`, `Date.now`, …) inside an `<Island>`. An island is empty in the
first paint and appears only after hydration, so it gets no first-paint HTML or
SEO, which is exactly right for "client only" content.

Opting in is always safe: a route (or a layout in its chain) that **throws**
under static markup is **skipped at build with a warning** and falls back to
normal client rendering. You never get a broken page from adding `ssr = true`;
worst case you get client rendering and a build warning telling you why.

---

## 2. The server `render`

The wasm `render(req_ofs, req_len) -> i64` export is surfaced by your
`server/main.ts` via `export * from 'toiljs/server/runtime/exports'` (the same
line that surfaces `handle`). At request time it decodes the request, runs the
`Ssr` router to find a matching render function, serializes that function's
`SlotValues` into the values envelope, and returns it packed as
`(ptr << 32) | len`.

A render function takes the `Request`, returns a filled `SlotValues` for a path
it owns, or `null` to let the next registered renderer try.

```ts
import { HtmlBuilder, Request, SlotValues, Ssr } from 'toiljs/server/runtime';
import { HASH, Slot } from './_ssr/hello.slots';

function renderHello(req: Request): SlotValues | null {
  // The guest re-derives WHICH route this is from the path (the template name
  // is not in the request envelope), exactly as a @rest controller matches its
  // own prefix. req.path includes the query string, so match both forms.
  if (req.path != '/hello' && !req.path.startsWith('/hello?')) return null;

  const v = new SlotValues(HASH);

  v.setText(Slot.name, greetingName(req));                 // escaped
  v.setRaw(Slot.blurb, 'Rendered at the <strong>edge</strong>.'); // verbatim

  const rows = new HtmlBuilder();
  for (let i = 0; i < services.length; i++) {
    const s = services[i];
    rows.raw('<li><strong>').text(s.name)
        .raw('</strong><span class="hello-region">').text(s.region)
        .raw('</span></li>');
  }
  v.setRepeat(Slot.services, rows);

  return v;
}

Ssr.register(renderHello); // side-effect registration
```

### Registration is manual; the import is load-bearing

`ssr-codegen` generates ONLY the `Slot` enum and the `HASH`, it does **not**
emit the render body and does **not** auto-register it. You write `renderHello`
and call `Ssr.register(renderHello)` yourself.

Crucially, `Ssr.register` runs as a **module side effect**, so the module must
be imported somewhere the build reaches. Non-surface files (a plain render
module is not a `@rest`/`@service`/`@data` file) are **not** auto-discovered, so
you must `import './SsrHelloRender'` in `server/main.ts`. Forgetting the import
means the renderer never registers, `Ssr.dispatch` returns `null`, and the route
falls back to the fail-safe 500.

### What `render` does for a request the router misses

If no registered renderer matches, the `render` export emits a **fail-safe**
envelope: status 500 with a **zeroed** 32-byte hash and no slots (a malformed
request envelope yields the same fail-safe with status 400). The edge rejects
the zero hash as a coherence mismatch, so a miss surfaces as a clean error
rather than a corrupt page.

---

## 3. Reference: `SlotValues`

Construct it with the route's compiled-in hash: `new SlotValues(HASH)`. Each
setter targets a slot id (a `Slot` enum member); the **kind** determines how the
edge splices it. All setters return `this` for chaining.

| Method | Signature | Escaping | Use |
| --- | --- | --- | --- |
| `setText` | `setText(slotId, value: string)` | **React-escaped** | text content (safe by default) |
| `setRaw` | `setRaw(slotId, html: string)` | **none (verbatim)** | raw HTML, *you* sanitize |
| `setAttr` | `setAttr(slotId, value: string)` | **React-escaped** | an attribute value |
| `setRepeat` | `setRepeat(slotId, rows: HtmlBuilder)` | per `HtmlBuilder` calls | a repeat region, pre-stamped row by row |
| `setHeader` | `setHeader(name, value)` |, | a response header (e.g. `Cache-Control`, `Set-Cookie`) |
| `setStatus` | `setStatus(code)` |, | the HTTP status (default 200) |

`setText` and `setAttr` escape identically (React escapes text and attributes
the same way). Slot ids passed are the `Slot` enum members; AS enums are `i32`,
so they pass without a cast and are narrowed to `u16` only at encode time.

### `HtmlBuilder`

Assembles a repeat region (or any HTML fragment) with the same escaping
guarantees. Chain `raw` (verbatim template bytes) and `text` / `attr`
(React-escaped values):

```ts
const rows = new HtmlBuilder();
for (let i = 0; i < items.length; i++) {
  rows.raw('<li>').text(items[i]).raw('</li>'); // items[i] is escaped
}
v.setRepeat(Slot.list, rows);
```

You are hand-writing the row markup, so it must match what `<Repeat>`'s child
produces for the same item, the build captured exactly that markup as the row
sub-template, and the edge inserts your stamped rows verbatim at the region
offset. Keep the **structure** the same across rows; only the leaf hole values
vary.

| Method | Signature | Escaping |
| --- | --- | --- |
| `raw` | `raw(s: string): HtmlBuilder` | verbatim |
| `text` | `text(s: string): HtmlBuilder` | React-escaped |
| `attr` | `attr(s: string): HtmlBuilder` | React-escaped (identical to `text`) |

---

## 4. Escaping (React-exact)

`setText`, `setAttr`, and `HtmlBuilder.text` / `.attr` escape **exactly as
React does** (`react-dom/server`'s `escapeTextForBrowser`, regex `/["'&<>]/`),
so the server-rendered markup and the client hydration agree byte-for-byte:

```
"  →  &quot;        &  →  &amp;        '  →  &#x27;
<  →  &lt;          >  →  &gt;
```

The detail that bites: `'` becomes `&#x27;` (React's exact choice), **not**
`&#39;`. If your escaping deviates from this by even one entity, `hydrateRoot`
sees different markup and React throws a hydration mismatch and re-renders the
subtree. The guest's `escapeHtml` and the build's `reactEscapeHtml` are pinned
to be byte-identical for exactly this reason.

`setRaw` and `HtmlBuilder.raw` do **not** escape, they insert your bytes
verbatim. That is the right tool for markup you produced or sanitized yourself
(the same contract as `dangerouslySetInnerHTML`), and the wrong tool for
anything derived from request input.

---

## 5. The build flow and generated artifacts

`extractTemplates` (driven by `toiljs build`) does, for each `ssr = true` route:

1. loads the route + its layout chain through a short-lived Vite SSR server;
2. calls the `loader` with sample params to get representative data;
3. renders the page under its layouts with the markers in **sentinel mode**
   (`__setSsrBuild(true)`), each marker emits a Private-Use-Area sentinel token
   instead of rendering normally;
4. splices that into the built shell's `<div id="root">` and adds the SSR marker
   `<template id="__toil_ssr"></template>` (this is what the client `mount` looks
   for to switch to `hydrateRoot`);
5. strips the sentinel tokens, records their **byte offsets**, and writes the
   artifacts.

### Where the artifacts land

For a route named `<name>` (see below), under `build/client/_ssr/`:

| File | Consumer | Contents |
| --- | --- | --- |
| `<name>.tmpl` | edge host (mmap'd) | the stripped static HTML shell, holes removed |
| `<name>.slots` | edge host | the binary manifest (offsets, ids, kinds, tmpl_len, hash) |
| `<name>.slots.ts` | guest build | the generated `Slot` enum + `HASH` AssemblyScript module |
| `templates.json` | index | `[{ route, name, hash }]` for every extracted template |

The `.tmpl` and `.slots` are then **copied** into the edge host bundle at
`hosts/edge/_tmpl/<name>.{tmpl,slots}`.

The build also writes the **server-importable** `Slot` + `HASH` module to
`server/_ssr/<name>.slots.ts`, the one your `render` imports. It is generated
and gitignored; never hand-edit it (see the two-pass note below).

### Route name derivation (`routeTemplateName`)

The `<name>` is a file-safe slug of the route pattern: non-alphanumerics collapse
to `_`, leading/trailing `_` are trimmed, empty → `index`.

| Route pattern | `<name>` |
| --- | --- |
| `/hello` | `hello` |
| `/` | `index` |
| `/u/:name` | `u_name` |
| `/blog/[id]` | `blog_id` |

### The two-pass build: no hand-kept slots

The final extraction runs **after** the Vite client build (the built shell's
hashed `<script>`/`<link>` tags are part of the template, so they must be in the
`HASH`), but the server (guest wasm) is compiled **before** it. A naive build
therefore can't generate `<name>.slots.ts` in time for the `render` to import
it. toiljs closes this with a **two-pass** build, so a clean build needs **zero
hand-maintained slots**:

1. **Slots pre-pass** (before the server build) renders every `ssr = true`
   route to its `Slot` enum + `HASH` and writes the server-importable module at
   `server/_ssr/<name>.slots.ts`. This is the file your `render` imports, it is
   **generated, gitignored, and never hand-edited**.
2. The server compiles against that module.
3. The client (Vite) builds.
4. **Final extraction** re-renders against the real built shell and rewrites
   `server/_ssr/<name>.slots.ts` with the authoritative `HASH`. If the hash
   rotated since the pre-pass, the build recompiles the server **once** so the
   guest bakes the deployed hash.

So authoring an SSR route is just the route + the `render`; the `Slot` / `HASH`
module is entirely build-managed. (On an unchanged rebuild the pre-pass reuses
the prior build's shell, so the hashes already match and step 4's recompile is
skipped.)

---

## 6. Hash coherence and the values envelope

Every values envelope carries the guest's compiled-in 32-byte `HASH`. The edge
compares it against the deployed template's hash and **rejects a mismatch** with
a fail-safe 500 rather than splicing values into the wrong template. A mismatch
means deploy skew: the guest was built against one version of the template and a
different one is deployed.

The hash is `sha256(tmpl || \0 || canonicalManifest(slots))`, so any change to
the static HTML, a hole's id/kind, or the repeat nesting rotates it.

The guest serializes `SlotValues` to this little-endian, no-padding layout (the
edge decodes it and splices against the template manifest):

```
u16  status
[32] template_hash
u16  n_headers
  for each header: u16 name_len, u16 val_len, name bytes, val bytes
u16  n_slots
  for each value:  u16 slot_id, u8 kind, u32 value_len, value bytes
```

`kind` is `0=text, 1=raw, 2=attr, 3=repeat`. The host keys values by `slot_id`
and inserts each at the **manifest-fixed** offset, so the guest can never choose
*where* bytes land, only what they are. If a value cannot be represented
(a count or length overflows its field width, or the hash is the wrong size),
the encoder writes the same fail-safe 500/zero-hash envelope instead of corrupt
bytes.

The matching `.slots` manifest the host reads is a 46-byte header
(`"TSLT"` magic, u16 version, u16 flags, u32 tmpl_len, 32-byte hash, u16 n_slots)
followed by 8-byte entries (`u32 offset, u16 slot_id, u8 kind, u8 reserved`).

---

## 7. Dev server and testing

`toiljs dev` serves SSR routes the same way the edge does. It runs the **real**
`render` export (`WasmServerModule.dispatchRender`), decodes the values
envelope, and splices the values into the route's template, so you get real
server-rendered HTML locally (`curl` a route, or view source), which then
hydrates in place. The dev template is extracted once at startup against the
live (Vite-transformed) dev shell rather than a built one; a route's per-request
**values** are always live, but a change to its **markup** needs a dev restart
to re-extract. A fail-safe envelope (no renderer matched) falls back to client
rendering.

The end-to-end test (`test/ssr-render.test.ts`) drives the same `dispatchRender`
path directly: it calls `dispatchRender({ path: '/hello' })`, decodes the
envelope, asserts the slots, and splices against the built `hello.tmpl`.

---

## 8. Complete worked example: `/hello`

This is the full, copy-pasteable chain. All four files are real and tested.

### `client/routes/hello.tsx` (the route)

```tsx
import { Hole, Island, RawHtml, Repeat, useLoaderData } from 'toiljs/client';

export const ssr = true;

export const metadata: Toil.Metadata = {
  title: 'Edge SSR',
  description: 'A server-rendered greeting, filled at the edge.',
};

interface Service { name: string; region: string; }
interface GreetingData {
  name: string;
  blurbHtml: string;
  services: Service[];
}

// Build-time sample data, only the SHAPE matters; the real per-request values
// come from the SERVER render. The repeat sample needs at least one row.
export const loader = ({ params }: { params: Record<string, string> }): GreetingData => ({
  name: params.name ?? 'world',
  blurbHtml: 'Rendered at the <strong>edge</strong> from a tiny values envelope.',
  services: [
    { name: 'record', region: 'us-east' },
    { name: 'unique', region: 'eu-west' },
    { name: 'counter', region: 'ap-south' },
  ],
});

export default function Hello(): React.JSX.Element {
  const d = useLoaderData<typeof loader>();
  return (
    <section className="hello">
      <h1>Hello, <Hole id="name">{d.name}</Hole>!</h1>

      <p className="hello-blurb">
        <RawHtml id="blurb" html={d.blurbHtml} as="span" />
      </p>

      <h2>Service snapshot</h2>
      <ul className="hello-services">
        <Repeat id="services" each={d.services}>
          {(s: Service) => (
            <li>
              <strong><Hole id="svcName">{s.name}</Hole></strong>
              <span className="hello-region"><Hole id="svcRegion">{s.region}</Hole></span>
            </li>
          )}
        </Repeat>
      </ul>

      <Island>
        <p className="hello-island">
          Hydrated in your browser at {new Date().toLocaleTimeString()}.
        </p>
      </Island>
    </section>
  );
}
```

### `server/_ssr/hello.slots.ts` (generated by the build; do not edit)

```ts
// AUTO-GENERATED by toil (edge SSR). Do not edit.

/** Stable hole ids for this route's template (document order). */
export enum Slot {
  name = 0,
  blurb = 1,
  services = 2,
}

/** Coherence hash (32 bytes), written by the build's slots pre-pass; the host
 * rejects a response whose hash != the deployed template. */
export const HASH: StaticArray<u8> = [
  0xcb, 0x12, 0x5e, 0x19, 0x46, 0x32, 0x58, 0x25, 0xd3, 0xf0, 0x44, 0xc5, 0x41, 0x0c, 0x34, 0x3b,
  0x69, 0xd3, 0x62, 0xb3, 0x24, 0x25, 0x79, 0xc4, 0x76, 0x89, 0xfb, 0x25, 0x6e, 0x35, 0x02, 0x31,
];
```

(Only the **top-level** holes get a `Slot` id, `name`, `blurb`, `services`. The
nested `svcName` / `svcRegion` live inside the repeat row sub-template, which the
guest stamps with `HtmlBuilder`, so they are not separate slots.)

### `server/SsrHelloRender.ts` (the render)

```ts
import { HtmlBuilder, Request, SlotValues, Ssr } from 'toiljs/server/runtime';
import { HASH, Slot } from './_ssr/hello.slots';

class Service {
  constructor(public name: string, public region: string) {}
}

/** Pull `?name=...`, defaulting to `world` (matches the route loader default). */
function greetingName(req: Request): string {
  const q = req.path.indexOf('?');
  if (q < 0) return 'world';
  const parts = req.path.substring(q + 1).split('&');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith('name=')) {
      const v = parts[i].substring(5);
      return v.length > 0 ? v : 'world';
    }
  }
  return 'world';
}

function renderHello(req: Request): SlotValues | null {
  if (req.path != '/hello' && !req.path.startsWith('/hello?')) return null;

  const v = new SlotValues(HASH);

  // Text hole, React-escaped (so ?name=<a>&b is safe).
  v.setText(Slot.name, greetingName(req));

  // Raw hole, verbatim; a fixed, trusted blurb (no request data).
  v.setRaw(Slot.blurb, 'Rendered at the <strong>edge</strong> from a tiny values envelope.');

  // Repeat, stamp the captured row markup once per item. The row sub-template
  // is <li><strong>{svcName}</strong><span class="hello-region">{svcRegion}</span></li>;
  // .text(...) escapes each nested hole exactly as React does.
  const services: Service[] = [
    new Service('record', 'us-east'),
    new Service('unique', 'eu-west'),
    new Service('counter', 'ap-south'),
  ];
  const rows = new HtmlBuilder();
  for (let i = 0; i < services.length; i++) {
    const s = services[i];
    rows.raw('<li><strong>').text(s.name)
        .raw('</strong><span class="hello-region">').text(s.region)
        .raw('</span></li>');
  }
  v.setRepeat(Slot.services, rows);

  return v;
}

// Side-effect registration: main.ts imports this module so the build compiles
// it in and this renderer joins the SSR router.
Ssr.register(renderHello);
```

### `server/main.ts` (the load-bearing import)

```ts
import { Server } from 'toiljs/server/runtime';
// ... other surface imports ...

// Edge SSR: importing the render module compiles it in and self-registers its
// /hello renderer. Without this import the renderer never registers.
import './SsrHelloRender';

Server.handler = () => new AppHandler();

export * from 'toiljs/server/runtime/exports'; // surfaces `handle` AND `render`
```

The spliced first-paint HTML for `GET /hello` is byte-identical to what React
renders for the same data:

```html
<section class="hello"><h1>Hello, world!</h1>
<p class="hello-blurb"><span>Rendered at the <strong>edge</strong> from a tiny values envelope.</span></p>
<h2>Service snapshot</h2>
<ul class="hello-services">
<li><strong>record</strong><span class="hello-region">us-east</span></li>
<li><strong>unique</strong><span class="hello-region">eu-west</span></li>
<li><strong>counter</strong><span class="hello-region">ap-south</span></li>
</ul></section>
```

The `<Island>` is empty here (no first paint); it fills in after hydration.

---

## 9. Pitfalls and debugging

- **Route skipped at build (warning, no SSR).** The route or a layout above it
  threw under static markup, almost always a router hook (`useRouter`,
  `usePathname`, …) or a browser-only API rendered outside an `<Island>`. The
  build prints `toil: SSR skipped <pattern> (...)` and the route falls back to
  client rendering. Move the offending content into an `<Island>`.

- **Hash mismatch / clean 500 after editing a template.** Any change to the
  page's static markup, a hole id/kind, or the repeat structure rotates the
  `HASH`. The host rejects a stale guest hash. A normal `toiljs build`
  regenerates `server/_ssr/<name>.slots.ts` and rebakes the guest, so this only
  surfaces from a partial or stale deploy (a guest built against a different
  template than the one deployed), never from hand-copied slots.

- **Hydration mismatch (flash / React re-render in the browser).** Two common
  causes. (1) The client **loader** does not reproduce the values the server
  `render` stamped. Hydration re-renders the route with the loader's data, so for
  any request-derived hole the loader must derive the **same** value the server
  `render` does (e.g. read the same `?query` / param). The two are separate
  sources (the client loader is TypeScript; the server `render` is the wasm
  guest), so keeping them in sync is the author's contract; if the client cannot
  reproduce a value, put that content in an `<Island>`. (2) A marker (or a
  non-static node) rendered outside an `<Island>`, or hole escaping that does not
  match React's (e.g. emitting `&#39;` instead of `&#x27;`, or using `setRaw`
  where the client would escape). Keep dynamic text in `<Hole>` / `setText` and
  client-only content in `<Island>`.

- **Route renders client-side only even though `ssr = true`.** You forgot to
  `import './SsrHelloRender'` in `server/main.ts`, so `Ssr.register` never ran
  and `Ssr.dispatch` returns `null`. Add the import. (Plain render modules are
  not auto-discovered the way `@rest`/`@service` files are.)

- **`setRaw` injecting unsanitized request data.** `setRaw` is verbatim, never
  pass it anything derived from request input you have not sanitized. Use
  `setText` for request-derived text.

- **Empty `<Repeat>` sample at build.** The build captures the row sub-template
  from the **first** sample row. If your build-time `loader` returns an empty
  array for a `<Repeat>`, there is no row to capture. Give the build sample at
  least one representative row.
</content>
</invoke>

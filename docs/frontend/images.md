# Images

`Toil.Image` is a drop-in replacement for `<img>` that stops layout shift, lazy-loads by default, and can fade in from a blurred placeholder. Use it for content images instead of a raw `<img>`.

## Why not just use `<img>`?

Two problems with a plain `<img>`:

1. **Layout shift.** Before the image loads, the browser does not know how tall it is, so the page has no space reserved. When the image arrives, everything below it jumps down. That jump hurts the user experience and your Core Web Vitals score (specifically CLS, Cumulative Layout Shift).
2. **Loading cost.** Every image loads eagerly by default, competing for bandwidth with the things the user actually needs first.

`Toil.Image` fixes both: it reserves the right amount of space up front, and it lazy-loads everything except the images you mark as high priority.

## The simplest usage

Give it a `src`, an `alt`, and a `width` + `height`. The width and height are the image's real pixel dimensions, and they are what reserve space so nothing jumps:

```tsx
export default function Post() {
  return (
    <Toil.Image
      src="/images/diagram.png"
      alt="How the request flows"
      width={800}
      height={400}
    />
  );
}
```

`alt` is required (toiljs enforces it for accessibility). For a purely decorative image, pass `alt=""`.

There is no server-side resizing here: `Toil.Image` is a client component. Point `src` at an already-optimized image. When you import an image (see below), Vite hashes and optimizes the file for you.

## Automatic blur placeholders with `?toil`

For a nicer loading experience you can show a tiny blurred preview of the image while the full one downloads. toiljs generates that preview automatically when you import the image with a `?toil` flag:

```tsx
import hero from './hero.webp?toil';

export default function Landing() {
  return <Toil.Image src={hero} alt="Product hero" placeholder="blur" />;
}
```

The `?toil` import does not give you a plain URL string. It gives you an object:

```ts
{
  src: string;          // the optimized, hashed image URL
  width: number;        // the image's intrinsic width
  height: number;       // the image's intrinsic height
  blurDataURL: string;  // a tiny base64 blurred preview, inlined
}
```

`Toil.Image` unpacks that object for you. So a `?toil` import auto-fills `width`, `height`, and the blur placeholder with **no extra props**: you do not repeat the dimensions, and `placeholder="blur"` just works. Explicit props still win if you pass them.

Behind the scenes, at import time toiljs uses `sharp` to downscale the image to about 24 pixels on its longest edge, blur it, and encode it as a small WebP data URI (a few hundred bytes) inlined right into your bundle. This runs in dev and in the build. Only raster images (`.png`, `.jpg`, `.webp`, `.avif`, `.gif`, `.tiff`) get a blur; SVGs and animated images are left as-is.

### The skeleton fallback

`placeholder="blur"` is never a silent no-op. If there is no `blurDataURL` (you used a string `src` and did not pass one), `Toil.Image` shows a neutral animated "skeleton shimmer" instead of a blur. Either way the placeholder needs a reserved box to paint into, so give it `width` + `height` (or use `fill`, below).

You can also pass a `blurDataURL` by hand for a plain string `src`:

```tsx
<Toil.Image
  src="/images/photo.jpg"
  alt="A photo"
  width={1200}
  height={800}
  placeholder="blur"
  blurDataURL="data:image/webp;base64,UklGR..."
/>
```

## The real layout-shift fix: aspect ratio

The important detail: the thing that actually prevents layout shift is not the blur, it is the **reserved aspect ratio**. When you pass both `width` and `height`, `Toil.Image` sets a CSS `aspect-ratio` derived from them. That reservation survives responsive CSS like `width: 100%` (a bare `width`/`height` attribute does not survive that). So the box holds its shape while the image loads, and nothing jumps. The blur is cosmetic; the reserved size is what holds.

The takeaway: always give `width` + `height` (or `fill`). A `?toil` import supplies them for you.

## `fill`: sizing from the container

Sometimes you do not know the image's size, you want it to fill a box you control (a card, a banner). Pass `fill`:

```tsx
<div style={{ maxWidth: 480 }}>
  <Toil.Image src={photo} alt="Cover" fill />
</div>
```

With `fill`, `Toil.Image` wraps the image in a block-level box and the image fills that box's width, scaling to its natural height. If you size the box yourself (with `width`/`height`, or a `style` like `aspectRatio: '16 / 9'`), the image *covers* that box, cropped according to `objectFit` (default `cover`):

```tsx
<Toil.Image
  src={photo}
  alt="Cover"
  fill
  style={{ aspectRatio: '16 / 9' }}
  objectFit="cover"
/>
```

The `fill` image flows in the normal document layout (it is never absolutely positioned), so it cannot escape to cover the whole page nor collapse to zero height, two common bugs with hand-rolled fill images. With `fill`, your `className` and `style` apply to the wrapper box, not the raw `<img>`.

Use fixed `width`/`height` when you know the image's size; use `fill` when the layout decides the size.

## Priority images (above the fold)

By default every `Toil.Image` lazy-loads: the browser fetches it only as it nears the viewport. That is right for most images, but wrong for the one big image at the top of the page (your hero, your LCP element). Mark that one `priority`:

```tsx
<Toil.Image src={hero} alt="Hero" width={1200} height={630} priority />
```

`priority` loads the image eagerly and sets `fetchPriority="high"`, telling the browser to fetch it right away. Use it only for the important above-the-fold image; everything else should stay lazy.

## Prop reference

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `src` | `string \| ToilImageSource` | (required) | A URL, or a `?toil` import object. |
| `alt` | `string` | (required) | Alt text. Use `""` for decorative images. |
| `width` / `height` | `number` | from `?toil` | Intrinsic size, reserves space. |
| `fill` | `boolean` | `false` | Fill the container instead of using fixed size. |
| `objectFit` | CSS `object-fit` | `cover` (with fill) | How the image fits its box. |
| `priority` | `boolean` | `false` | Eager load + high fetch priority (above-the-fold). |
| `placeholder` | `'empty' \| 'blur'` | `'empty'` | Show a blur / skeleton while loading. |
| `blurDataURL` | `string` | from `?toil` | The tiny preview for `placeholder="blur"`. |

Every other standard `<img>` attribute (`className`, `style`, `onLoad`, `sizes`, `srcSet`, `id`, `data-*`) passes straight through.

## Gotchas

- **No server-side resizing.** `Toil.Image` does not shrink or convert your image at request time. Ship an appropriately sized `src` (importing it lets Vite optimize and hash it). The `?toil` blur is only a placeholder, not a resized copy.
- **A placeholder needs a reserved box.** `placeholder="blur"` only shows if there is a size to paint into. Give `width` + `height`, or use `fill` inside a sized parent.
- **`?toil` is for raster images.** SVGs and animated formats do not get a generated blur (importing them with `?toil` skips the blur step). Import an SVG normally.
- **`alt` is mandatory.** This is intentional. For decorative images that add no meaning, pass `alt=""` so screen readers skip them.
- **Do not double up dimensions with a `?toil` import.** The import already carries `width`/`height`; passing them again is redundant (though harmless, explicit props win).

## Related

- [Styling](./styling.md): importing images and CSS in general.
- [Metadata and SEO](./metadata.md): setting `og:image` for social-share previews.
- [Rendering and SSR](./rendering.md): why first-paint layout stability matters.

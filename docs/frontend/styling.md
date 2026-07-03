# Styling

toiljs does not force a styling system on you. It builds with Vite, so you style your app the way you would any Vite + React project: plain CSS, CSS Modules, a preprocessor like Sass, or Tailwind. This page shows the practical options.

## The one import that matters

Your app pulls in global styles from the entry file, `client/toil.tsx`:

```tsx
// client/toil.tsx
import { routes, layout, notFound, globalError, slots } from 'toiljs/routes';
import './styles/main.css';   // <- your global stylesheet

Toil.mount(routes, layout, notFound, globalError, slots);
```

That one import is where your global CSS (resets, CSS variables, base element styles) lives. A typical `client/styles/main.css` sets up theme variables and base styles:

```css
/* client/styles/main.css */
:root {
  --accent: #2563ff;
  --bg: #080d11;
  --text: #f5f6fa;
}

*, *::before, *::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1.6;
}
```

## Importing CSS anywhere

You are not limited to the one global sheet. Any component can import its own CSS, and Vite bundles it in:

```tsx
// client/components/Card.tsx
import './card.css';

export default function Card() {
  return <div className="card">...</div>;
}
```

The class names in a plain `.css` file are global (they apply everywhere), so name them carefully to avoid clashes, or reach for CSS Modules.

## CSS Modules (scoped class names)

If you name a file `*.module.css`, Vite treats it as a **CSS Module**: the class names are locally scoped to the component that imports them, so two components can both use `.title` without colliding. You import the generated names as an object:

```tsx
// client/components/Card.tsx
import styles from './card.module.css';

export default function Card() {
  return <div className={styles.card}>...</div>;
}
```

```css
/* client/components/card.module.css */
.card {
  padding: 1rem;
  border: 1px solid var(--border);
}
```

This is the simplest way to get component-scoped styles with no extra tooling.

## Preprocessors: Sass, Less, Stylus

When you create a project (`toiljs create`) you can pick a CSS preprocessor, or add one later to an existing project with the `configure` command:

```sh
toiljs configure                 # interactive: choose preprocessor + Tailwind
toiljs configure --style sass    # switch the preprocessor to Sass
```

`configure` installs the right packages and rewrites your style imports for you. After that, `.scss` / `.sass` / `.less` / `.styl` files import exactly like `.css` files, and Vite compiles them.

## Tailwind

To use Tailwind (a utility-class CSS framework), turn it on at create time or add it later:

```sh
toiljs configure --tailwind
```

Tailwind lives in its own stylesheet, `client/styles/tailwind.css`, which is just:

```css
@import "tailwindcss";
```

`configure` wires that import in for you. From then on you use Tailwind's utility classes directly in your JSX:

```tsx
export default function Cta() {
  return (
    <button className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white">
      Get started
    </button>
  );
}
```

## Inline styles and the `style` prop

Standard React inline styles work as always, and are handy for one-off, dynamic values:

```tsx
<div style={{ padding: 24, background: 'var(--surface)' }}>...</div>
```

Prefer classes for anything reused; keep inline styles for the truly per-instance case (a computed width, a dynamic color).

## How types work for style and asset imports

toiljs generates a `toil-env.d.ts` in your project that declares the import types, so TypeScript is happy importing stylesheets and images. It covers `.css`, `.scss`, `.sass`, `.less`, `.styl` (and friends), plus image formats (`.svg`, `.png`, `.jpg`, `.webp`, and so on), which import as a URL string:

```tsx
import logoUrl from './logo.svg';   // logoUrl is a string (a hashed URL)

<img src={logoUrl} alt="Logo" />
```

For images specifically, prefer the `Toil.Image` component and its `?toil` import, which also handle layout shift and blur placeholders (see [Images](./images.md)).

## Gotchas

- **Global CSS is global.** A plain `.css` import puts its class names in one shared namespace. If two files both define `.button`, the last one loaded wins. Use `*.module.css` (CSS Modules) or unique prefixes to scope styles.
- **Do not hand-edit `toil-env.d.ts`.** It is generated. If a new file type is not recognized, re-run the build so it regenerates, rather than editing it.
- **Preprocessor packages are managed by `configure`.** Add or switch preprocessors through `toiljs configure` so the packages and imports stay in sync; do not install them by hand.

## Related

- [Images](./images.md): the `Toil.Image` component and image imports.
- [The CLI](../cli/README.md): `toiljs configure` and every flag.
- [Frontend overview](./README.md): where styles fit in the `client/` folder.

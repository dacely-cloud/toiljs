# Styling

The app imports one stylesheet from `client/toil.tsx` (e.g. `./styles/main.css`).

## Preprocessors & Tailwind

Pick a CSS preprocessor (none / Sass / Less / Stylus) and optionally Tailwind at
`toiljs create`, or change it later on an existing project:

```sh
toiljs configure                 # interactive
toiljs configure --tailwind      # add Tailwind
toiljs configure --style sass    # switch preprocessor
```

`configure` installs/removes the right packages and rewrites the imports. Tailwind lives
in its own `styles/tailwind.css` (`@import "tailwindcss";`).

## Imports

`.css` / `.scss` / `.sass` / `.less` / `.styl` and image imports (`.svg`, `.png`, …) are
typed via `toil-env.d.ts`.

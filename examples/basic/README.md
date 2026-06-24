# toiljs basic example

A [toiljs](https://toil.org) app showcasing the **L1 request tier** end to end: file-based React
routes (SSR + hydration), server `@rest` routes, typed `@service` / `@remote` RPC, and `@data`
models with migrations.

For the multi-tier model - adding an L2/L3 `@stream` surface and an L4 `@daemon`, each compiled
into its own artifact - see the `streams` example.

## What's in here

- `client/routes/*` - file-based React pages.
- `server/routes/*` - `@rest` endpoints (Auth, Guestbook, Leaderboard, Players, Session, EnvDemo).
- `server/services/Stats.ts` - a `@service` exposing typed `@remote` methods to the client.
- `server/models/*` + `server/migrations/*` - `@data` models and their migrations.

This whole app compiles into a single `build/server/release.wasm` (the legacy single-artifact
build), because it declares no `@stream` or `@daemon` surface.

## Develop

    npm install
    npm run dev

## Build

    npm run build

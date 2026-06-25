# toiljs

A full-stack React framework: a Vite-bundled client SPA with file-based routing, plus a
toilscript-to-WebAssembly server target.

## Project layout

- `client/`, the app: `routes/` (file-based), `layout.tsx`, `components/`, `styles/`,
  `public/`, and `toil.tsx` (the entry that calls `Toil.mount`).
- `server/`, the toilscript → WASM target (`@main` entry), compiled by `toilscript`.
  `@data`/`@remote`/`@service` here generate the typed client `Server` API (see [server.md](./server.md)).
- `toil.config.ts`, configuration via `defineConfig` (`toiljs.config.ts` also works).
- Generated, gitignored, do not edit: `.toil/` (working dir), `toil-env.d.ts` (ambient
  globals), `toil-routes.d.ts` (typed routes), `shared/server.ts` (the typed RPC module,
  emitted by the server build; import `@data` classes from `shared/server`).

## Key ideas

- `Toil` is a native global (no import): `Toil.Link`, `Toil.useRouter`, `Toil.useLoaderData`,
  etc. The IO classes (`FastMap`, `FastSet`, `DataWriter`, `DataReader`), `parseError`, and the
  generated `Server` RPC surface are globals too.
- Scripts: `npm run dev` (HMR), `npm run build` (→ `build/client` + `build/server`),
  `npm start` (self-host the build).
- Compute tiers: the server can span L1 request (`server/main.ts`, `@rest`/`@service`/`@remote`),
  L2/L3 stream (`server/main.stream.ts`, `@stream`), and L4 daemon (`server/main.daemon.ts`,
  `@daemon`/`@scheduled`); each tier compiles into its own artifact. See [tiers.md](./tiers.md).

See [routing.md](./routing.md), [client.md](./client.md), [styling.md](./styling.md),
[server.md](./server.md), [ssr.md](./ssr.md), [rpc.md](./rpc.md), [tiers.md](./tiers.md),
[streams.md](./streams.md), [daemon.md](./daemon.md), [derive.md](./derive.md), [cli.md](./cli.md).

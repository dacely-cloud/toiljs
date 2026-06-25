# CLI

- `toiljs create [name]`, scaffold a project. Flags: `--template app|minimal`,
  `--style css|sass|less|stylus`, `--tailwind`, `--no-ai`, `-y`/`--yes`.
- `toiljs dev`, dev server with HMR (`--port`, `--root`). With a `toilconfig.json` it builds
  the server first, then rebuilds it whenever a `server/` file changes (regenerating
  `shared/server.ts`, which Vite HMRs into the client); client-only edits just HMR the client.
- `toiljs build`, production build. With a `toilconfig.json` it builds the server (toilscript,
  regenerating `shared/server.ts`) first, then the client → `build/client`. `--server` builds
  only the server. Every `server/` file declaring a surface (`@data`/`@rest`/...) is compiled.
- `toiljs start`, self-host the built app with production hyper-express/uWS static workers,
  SSR/wasm dispatch, daemon support, and a `/_toil` WebSocket channel. Use `--threads <n>`
  (or `server.threads`) to set the worker count; `1` disables the pool.
- `toiljs configure`, toggle styling features on an existing project (see [styling.md](./styling.md)).
- `toiljs doctor`, diagnose project setup (`--json` for CI). `--fix` auto-wires the typed-RPC
  setup (build scripts, tsconfig `shared` + alias, `.gitignore`, toilscript version, and the
  toilscript prettier plugin) so an existing project upgrades in one command.

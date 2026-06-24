# server/

Your ToilScript backend, compiled to a single WebAssembly module. One folder per concern:

| Folder | What lives here |
| --- | --- |
| `main.ts` | The entry point: wires the handler and imports the surface modules. |
| `core/` | The request handler and shared app logic (state, helpers). |
| `models/` | `@data` classes, the typed wire model shared by HTTP and RPC. One type per file. |
| `migrations/` | ToilDB schema migrations: a `<Type>.migration.ts` per evolving `@data` value type, holding the old shapes + the `@migrate` transform. |
| `routes/` | `@rest` controllers (HTTP). One controller per file, named after its class. |
| `services/` | `@service` classes and free `@remote` functions (typed RPC). |
| `scheduled/` | Reserved for scheduled tasks (not shipped yet). |

New decorated files are picked up automatically by `toiljs build`/`dev`; also add an import
in `main.ts` so a direct `toilscript` run builds the same server.

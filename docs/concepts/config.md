# Configuration (`toil.config.ts`)

`toil.config.ts` is the one file that configures your whole toiljs app: the client (React/Vite) side and the server (WebAssembly) side. Every field is optional and has a sensible default, so most projects keep it tiny.

## The shortest possible config

A scaffolded project ships something like this:

```ts
// toil.config.ts
import { defineConfig } from 'toiljs/compiler';

export default defineConfig({
    client: {
        // Optimize images at build time (resize and compress imported images).
        images: true,
    },
});
```

`defineConfig` does not do anything at runtime: it is an identity helper that gives you full editor autocomplete and type-checking for the config shape. Always wrap your config in it.

An empty config is valid too. `export default defineConfig({})` gives you a working app with all defaults.

## Where the file lives

toiljs looks in your project root for the first file that matches, in this order:

```
toil.config.ts    toil.config.mts    toil.config.js    toil.config.mjs
toiljs.config.ts  toiljs.config.mts  toiljs.config.js  toiljs.config.mjs
```

Use whichever you like. `toil.config.ts` is the convention.

## Config vs. environment variables

There are two very different places settings live, and it matters which one you use.

| | `toil.config.ts` (this page) | Environment variables |
| --- | --- | --- |
| **When it applies** | Build time and dev time | Runtime, per request |
| **What it holds** | Framework and build options (routing, styling, SEO, which features to compile) | Values and secrets your running server reads (API keys, feature flags, connection info) |
| **Committed to git?** | Yes, it is source | No. Local values go in `.env` / `.env.secrets` (both gitignored); production values live on your deploy target |
| **Read in code with** | Not read from your app code | `Environment.get(...)` / `Environment.getSecure(...)` on the server |

Rule of thumb: if it is a **secret** (a password, an API key, a session key), it does **not** go in `toil.config.ts`. It goes in the environment. See [Environment and secrets](../services/environment.md) for the full story.

There is also a **third** file, `toilconfig.json`, which is a different thing entirely. See [`toil.config.ts` is not `toilconfig.json`](#toilconfigts-is-not-toilconfigjson) at the bottom.

## The top-level shape

```ts
interface ToilConfig {
    root?: string;         // project root (defaults to the current working directory)
    client?: ClientConfig; // the React / Vite frontend
    server?: ServerConfig; // the toilscript / WebAssembly backend
}
```

Everything else lives under `client` or `server`.

## `client` reference

Configures the frontend: source folders, the dev server, and build-time optimizations.

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `srcDir` | `string` | `"client"` | Your frontend source directory, relative to the project root. |
| `routesDir` | `string` | `"routes"` | Your file-based routes directory, relative to `srcDir`. |
| `publicDir` | `string` | `"<srcDir>/public"` | Static assets directory. Holds `index.html` (which you own) plus files served as-is (favicons, images). |
| `outDir` | `string` | `"build/client"` | Where the production client bundle is written. |
| `base` | `string` | `"/"` | The public base path. Use this if you serve the app under a sub-path (a non-root base should start and end with `/`, like `"/app/"`). |
| `port` | `number` | `3000` | The dev server port. `--port` on the CLI overrides it. |
| `images` | `boolean` | `true` | Optimize imported images at build time (resize and convert). See [Images](../frontend/images.md). |
| `fonts` | `boolean` | `true` | Preload bundled fonts (inject `<link rel="preload">` for each `@font-face`) so text paints faster. |
| `viewTransitions` | `boolean` | `false` | Animate page navigations with the browser View Transitions API (a crossfade by default). Respects `prefers-reduced-motion`. |
| `transitions` | `boolean` | `false` | Wrap navigations in a React transition, keeping the current page visible while the next route's loader runs (instead of showing its loading state immediately). |
| `devtools` | `boolean` or object | `true` | The floating dev toolbar (route/build info, errors, live controls). It is dev-only and never ships in production. Set `false` to disable, or pass an object to configure its AI integration. |
| `seo` | object | (off) | Build-time SEO: bakes site-level metadata into the HTML and generates `robots.txt`, `sitemap.xml`, `llms.txt`. See [`client.seo`](#clientseo) below. |
| `vite` | Vite `InlineConfig` | `{}` | An escape hatch: raw Vite options, deep-merged over the framework's own Vite setup. toiljs owns the Vite config; use this only to override specific options. |

### Example

```ts
import { defineConfig } from 'toiljs/compiler';

export default defineConfig({
    client: {
        images: true,
        fonts: true,
        viewTransitions: true,
        // Serve the app under https://example.com/app/
        base: '/app/',
    },
});
```

### `client.devtools`

The dev toolbar is on by default. To turn it off, or to give it an AI provider (so its "explain this error" helpers can call a model), pass an object:

```ts
import { defineConfig, AiProvider } from 'toiljs/compiler';

export default defineConfig({
    client: {
        devtools: {
            ai: {
                provider: AiProvider.Anthropic, // 'anthropic' or 'openai'
                model: 'claude-sonnet-4-6',
                // The name of the env var holding the API key. It is read
                // server-side by the dev process and never sent to the browser.
                apiKeyEnv: 'ANTHROPIC_API_KEY',
                // Optional: a custom POST endpoint ({ prompt } in, { text } out)
                // that overrides `provider` entirely.
                // endpoint: 'http://localhost:5000/ai',
            },
        },
    },
});
```

| `devtools.ai` field | Type | What it does |
| --- | --- | --- |
| `provider` | `AiProvider` | Built-in provider: `AiProvider.Anthropic` (`'anthropic'`) or `AiProvider.OpenAI` (`'openai'`). |
| `model` | `string` | The model id, for example `'claude-sonnet-4-6'` or `'gpt-4o'`. |
| `apiKeyEnv` | `string` | The **name** of the environment variable that holds the API key. The key stays server-side and never reaches the browser. |
| `endpoint` | `string` | A custom POST endpoint. When set, it takes precedence over `provider`. |

The toolbar always offers hand-off links to Claude and ChatGPT even without any AI config; this only enables the in-toolbar helpers.

### `client.seo`

`client.seo` turns on build-time search-engine and social metadata. It bakes tags into your HTML `<head>` (so crawlers and link-preview bots that do not run JavaScript still see real metadata) and generates `robots.txt`, `sitemap.xml`, and `llms.txt`. This is a large section with its own guide; see [Metadata and SEO](../frontend/metadata.md) for the complete field list and examples. The one thing worth knowing here: set `seo.url` to your absolute site URL (like `"https://example.com"`), because the sitemap and canonical links need it.

```ts
export default defineConfig({
    client: {
        seo: {
            url: 'https://example.com',
            title: 'My App',
            description: 'A toiljs app.',
        },
    },
});
```

## `server` reference

Configures the backend: which platform features to compile in, and how the dev server and self-host behave.

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `auth` | `boolean` | `false` | Opt into the framework's built-in post-quantum login. See [`server.auth`](#serverauth) below. |
| `email` | object | (off) | The non-secret email backend config for the dev server and self-host. See [`server.email`](#serveremail) below. |
| `daemon` | object | (defaults) | Background-job (L4 daemon) settings for dev and self-host. See [`server.daemon`](#serverdaemon) below. |
| `nodeMode` | string | `"all"` | Which compute layer the single dev/self-host process emulates. See [`server.nodeMode`](#servernodemode) below. |
| `threads` | `number` or `"auto"` | `"auto"` | HTTP worker count for `toiljs start`. `"auto"` uses one per CPU; `1` disables the worker pool. `--threads` on the CLI overrides it. |
| `srcDir` | `string` | `"server"` | Declarative: your server source directory. See the note below. |
| `outDir` | `string` | `"build/server"` | Declarative: the server build output directory. See the note below. |

> **Note on `server.srcDir` / `server.outDir`.** These fields exist in the config type, but the actual location of your server source and its compiled output is driven by `toilconfig.json` (the toilscript compiler config), not by these two fields. Change your server paths in `toilconfig.json`. These fields are currently declarative and left for forward compatibility. See [not `toilconfig.json`](#toilconfigts-is-not-toilconfigjson) below.

### `server.auth`

Set `auth: true` to get a complete post-quantum login system with no boilerplate. The build appends a shipped `@rest('auth')` controller and its `@user` shape to your server, giving you `/auth/register`, `/auth/login`, `/auth/me`, and `/auth/logout` plus sessions.

```ts
export default defineConfig({
    server: {
        auth: true,
    },
});
```

Two things to know:

- If you opt in, your app must **not** declare its own `@user` type. The built-in auth owns the single per-program one.
- There is an escape hatch: adding `import 'toiljs/server/auth'` in `server/main.ts` turns on the same built-in auth surface without this flag.

Auth has its own configuration (session secrets, the OPRF and KEM keys) that lives in the **environment**, not here. See [Auth configuration](../auth/configuration.md).

### `server.email`

The **non-secret** part of your email setup: which provider, the "from" address, and send caps. The dev server and self-host read it. The API key or SMTP password is a **secret** and never goes here; it comes from `.env.secrets` (`TOIL_EMAIL_API_KEY`). Any `TOIL_EMAIL_*` environment variable overrides the matching field here.

```ts
export default defineConfig({
    server: {
        email: {
            provider: 'resend',
            from: 'hello@example.com',
            maxPerMin: 60,
        },
    },
});
```

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `provider` | `'resend'` \| `'gmail'` \| `'smtp'` | `'resend'` | Which email backend to use. |
| `from` | `string` | (none) | The "from" address. Validated (single address, no line breaks). |
| `maxPerMin` | `number` | `60` | Per-process send ceiling per minute (rolling). `0` means unlimited. |
| `maxPerDay` | `number` | `0` | Per-process send ceiling per day (rolling). `0` means unlimited. |
| `maxPerRecipientPerHour` | `number` | `5` | Per-recipient hourly cap (anti-abuse). |
| `smtp` | object | (none) | Connection details for the `gmail` / `smtp` providers: `host`, `port` (defaults to 587 STARTTLS; 465 is implicit TLS), and `user` (defaults to `from`). |

See the full guide at [Email and 2FA](../services/email.md).

### `server.daemon`

Settings for the daemon (L4) background layer, used by the dev process and self-host. In dev, the local process is always the leader, so region fields are informational.

```ts
export default defineConfig({
    server: {
        daemon: {
            defaultIntervalMs: 60000,
            maxTasks: 64,
        },
    },
});
```

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `region` | `string` | (none) | Region the daemon is pinned to (informational in dev). |
| `standbyRegion` | `string` | (none) | Warm standby region (informational in dev). |
| `defaultIntervalMs` | `number` | `60000` | Default interval for a `@scheduled` task that declares none. Values below `1000` are clamped up to `1000` (a sub-second loop would flood the console). |
| `tickBudgetMs` | `number` | `30000` | Per-tick wall-clock budget before the dev scheduler logs an overrun. |
| `gasTick` | `number` | `0` | Per-tick gas cap (a dev stub: charged then ignored). |
| `maxTasks` | `number` | `64` | Maximum number of `@scheduled` tasks. Clamped to the range 1 to 1024. |

See [Daemons and scheduled jobs](../background/daemons.md).

### `server.nodeMode`

Which compute layer the single local process emulates. This is a dev and self-host knob only; in production the Dacely edge decides each server's role. Valid values are `hot`, `regional`, `continental`, `daemon`, and `all`. The default, `all`, runs every surface (requests, streams, and daemons) in one process, which is what you want for a full local run. An invalid value falls back to `all` with a warning rather than failing. See [Compute tiers (L1 to L4)](../concepts/tiers.md) for what each layer means.

```ts
export default defineConfig({
    server: {
        nodeMode: 'all', // run everything locally (the default)
    },
});
```

## Defaults at a glance

If you write nothing, this is what you get.

| Setting | Default |
| --- | --- |
| `client.srcDir` | `"client"` |
| `client.routesDir` | `"routes"` |
| `client.publicDir` | `"client/public"` |
| `client.outDir` | `"build/client"` |
| `client.base` | `"/"` |
| `client.port` | `3000` |
| `client.images` | `true` |
| `client.fonts` | `true` |
| `client.viewTransitions` | `false` |
| `client.transitions` | `false` |
| `client.devtools` | on |
| `client.seo` | off |
| `server.auth` | `false` |
| `server.email` | off |
| `server.nodeMode` | `"all"` |
| `server.threads` | `"auto"` |
| `server.daemon.defaultIntervalMs` | `60000` |
| `server.daemon.tickBudgetMs` | `30000` |
| `server.daemon.maxTasks` | `64` |

## A fuller example

```ts
import { defineConfig, AiProvider } from 'toiljs/compiler';

export default defineConfig({
    client: {
        images: true,
        fonts: true,
        viewTransitions: true,
        seo: {
            url: 'https://example.com',
            title: 'Example',
            description: 'Built with toiljs.',
        },
        devtools: {
            ai: { provider: AiProvider.Anthropic, model: 'claude-sonnet-4-6', apiKeyEnv: 'ANTHROPIC_API_KEY' },
        },
    },
    server: {
        auth: true,
        email: { provider: 'resend', from: 'hello@example.com' },
        threads: 'auto',
    },
});
```

## `toil.config.ts` is not `toilconfig.json`

These two look almost the same and are easy to confuse. They are not the same file.

| File | What it is |
| --- | --- |
| `toil.config.ts` | **This page.** The framework config: client and server options, styling, SEO, which features to build. You edit it often. |
| `toilconfig.json` | The **toilscript compiler** config: which server files are entry points, where the `.wasm` is written, and low-level WebAssembly options (optimization level, memory layout, enabled wasm features). It is scaffolded for you and you rarely touch it. Its presence is also what tells toiljs "this project has a server." |

If you ever need to change where your server source lives or what the compiled artifact is named, that is `toilconfig.json`, not `toil.config.ts`.

## The `toilconfig.json` reference

`toilconfig.json` is the **toilscript compiler** config. toilscript is the compiler that turns your `server/` TypeScript into a `.wasm` file (WebAssembly, the sandboxed binary your backend ships as). This file tells toilscript which server files to compile, where to write the output, and which low-level WebAssembly options to use.

`toiljs create` scaffolds it for you and most projects never touch it. You only edit it if you want to rename the compiled artifact, move your server entry, or hand-tune the WebAssembly codegen. Its presence at the project root is also the signal toiljs uses to decide "this project has a server" (a project with no `toilconfig.json` is a client-only app).

A scaffolded file looks like this:

```json
{
    "entries": ["server/main.ts"],
    "targets": {
        "release": {
            "outFile": "build/server/release.wasm",
            "textFile": "build/server/release.wat"
        }
    },
    "options": {
        "sourceMap": false,
        "optimizeLevel": 3,
        "shrinkLevel": 1,
        "converge": true,
        "noAssert": false,
        "enable": [
            "sign-extension",
            "mutable-globals",
            "nontrapping-f2i",
            "bulk-memory",
            "simd",
            "reference-types",
            "multi-value"
        ],
        "runtime": "stub",
        "lib": ["node_modules/toiljs/server/globals"],
        "memoryBase": 65536,
        "initialMemory": 4,
        "debug": false,
        "trapMode": "allow"
    }
}
```

### `entries`

An array of your server entry files: the toilscript starting points for the compile. The scaffold lists just `server/main.ts`, and `main.ts` imports your other surface modules so they all get pulled in. (Under `toiljs build`, toiljs compiles every decorated server file it finds, not only the entries, so a `@rest` or `@data` file you drop in is picked up even if `main.ts` does not import it.)

A project that also has a streams tier or a daemon tier lists their entry files here too, so each tier can compile into its own artifact:

```json
"entries": ["server/main.ts", "server/main.stream.ts", "server/main.daemon.ts"]
```

### `targets`

A map of named build targets. Each target names its output files. The scaffold has one target, `release`.

| Field | Type | What it does |
| --- | --- | --- |
| `outFile` | `string` | Where the compiled `.wasm` is written. The scaffold uses `build/server/release.wasm`. |
| `textFile` | `string` | Where the `.wat` (WebAssembly **text** format, the human-readable text form of the same module) is written. Handy for inspecting the output; not needed at runtime. |

### `options`

Low-level WebAssembly codegen options passed straight to toilscript. The defaults are already tuned for production, so change these only if you know you need to.

| Field | Type | Scaffold value | What it controls |
| --- | --- | --- | --- |
| `sourceMap` | `boolean` | `false` | Emit a source map alongside the `.wasm` so a debugger can map machine code back to your TypeScript. Off by default (it makes the build bigger). |
| `optimizeLevel` | `number` | `3` | How hard the optimizer works on **speed**, from `0` (none) to `3` (most). `3` is a production release setting. |
| `shrinkLevel` | `number` | `1` | How hard the optimizer works on **size**, from `0` to `2`. `1` trades a little speed for a smaller binary. |
| `converge` | `boolean` | `true` | Re-run the optimizer until the output stops getting better. Squeezes out a bit more at the cost of a slower build. |
| `noAssert` | `boolean` | `false` | Strip `assert(...)` checks from the output (replace them with just their value, no trap). `false` keeps the safety checks in. |
| `enable` | `string[]` | (see below) | Which modern WebAssembly features the compiled module is allowed to use. |
| `runtime` | `string` | `"stub"` | The memory-management runtime baked into the module. `"stub"` is a minimal runtime that never frees memory, which fits toiljs's model exactly: the edge runs one fresh instance per request and throws its whole memory away when the request ends, so there is nothing to garbage-collect. |
| `lib` | `string[]` | `["node_modules/toiljs/server/globals"]` | Extra library paths whose top-level exports become **ambient globals** (usable with no `import`). This is what makes toiljs's server globals (like `crypto` and the auth primitives) available everywhere in `server/`. |
| `memoryBase` | `number` | `65536` | The byte offset where your server's static data starts. toiljs reserves the first 64 KiB (`[0, 65536)`) for the **request envelope** the edge writes at offset 0, so a large request body can never overwrite your program's state. Raise it to accept larger request bodies (it costs a little more initial memory). |
| `initialMemory` | `number` | `4` | How much linear memory the module starts with, in **pages**. One WebAssembly page is 64 KiB, so `4` is 256 KiB. It grows on demand past this. |
| `debug` | `boolean` | `false` | Include debug information (names and the like) in the binary. Off for production. |
| `trapMode` | `string` | `"allow"` | What happens on a trapping operation (like a bad float-to-int conversion). `"allow"` lets it trap (the default and correct choice); `"clamp"` replaces traps with clamping instead. |

The `enable` array turns on WebAssembly features that are off by default in the compiler. The scaffold enables the modern set the compiled server relies on: `sign-extension`, `mutable-globals`, `nontrapping-f2i` (non-trapping float-to-int conversions), `bulk-memory` (fast `memory.copy` / `memory.fill`), `simd` (vector operations), `reference-types`, and `multi-value` (functions that return more than one value). Leave this list as scaffolded unless you have a specific reason to change it; removing an entry can make the module fail to compile or run.

### The `--rpcModule` build flag

One toilscript flag is worth knowing even though it lives in your npm scripts, not in `toilconfig.json`: `--rpcModule shared/server.ts`. It tells the compiler to also emit `shared/server.ts`, the fully typed client the browser imports to call your server (the `@data` codec plus the typed `Server` surface). toiljs adds this flag for you on the request build. If your `build:server` script is missing it (older projects predate it), `toiljs doctor --fix` injects it. See [the CLI reference](../cli/README.md#what---fix-repairs).

## Gotchas

- **Wrap the config in `defineConfig`.** Without it you lose autocomplete and type errors on typos.
- **Secrets never go here.** API keys, session secrets, and passwords belong in the environment, not in `toil.config.ts` (which is committed to git). See [Environment and secrets](../services/environment.md).
- **`server.srcDir` / `server.outDir` do not move your server.** The server source location is governed by `toilconfig.json` entries. Editing these two config fields has no effect today.
- **`nodeMode` and `daemon` are dev/self-host only.** In production the edge assigns each server its role; these settings never override that.
- **An invalid `nodeMode` does not crash the build.** It warns and falls back to `all`.

## Related

- [The CLI](../cli/README.md): the commands that read this config.
- [Environment and secrets](../services/environment.md): runtime values and how they differ from build-time config.
- [Auth configuration](../auth/configuration.md): the auth-related environment settings behind `server.auth`.
- [Email and 2FA](../services/email.md): the full email setup behind `server.email`.
- [Metadata and SEO](../frontend/metadata.md): the full `client.seo` field list.
- [Daemons and scheduled jobs](../background/daemons.md): the background layer behind `server.daemon`.
- [Compute tiers (L1 to L4)](../concepts/tiers.md): what `server.nodeMode` selects.
- [Images](../frontend/images.md) and [Styling](../frontend/styling.md): the features `client.images` and `toiljs configure` control.

# Installation

Install the toiljs command-line tool (CLI) so you can create and run projects. This takes a couple of minutes.

## Why and when

You need the toiljs CLI once, before you create your first project. The CLI is the single tool you use to scaffold, run, build, and check toiljs apps. After a project exists, the same CLI is also installed inside that project, so day-to-day you can run it through your package scripts (`npm run dev`) without a global install.

## Prerequisites

You need **Node.js version 24.0.0 or newer**. Node.js is the JavaScript runtime that powers the toiljs CLI, the dev server, and the build. (Your backend does not run on Node.js, but the tools that build it do.)

Check your version:

```sh
node --version
```

If it prints `v24.0.0` or higher, you are set. If it is older or the command is not found, install a current Node.js from [nodejs.org](https://nodejs.org), or use a version manager like [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm):

```sh
# with nvm
nvm install 24
nvm use 24
```

You also need a package manager. **npm** comes with Node.js, so you already have it. toiljs also supports **pnpm**, **yarn**, and **bun** if you prefer one of those.

### TypeScript 7

toiljs requires **TypeScript 7** (`>=7.0.2 <8.0.0`). The native compiler is shipped in the
`typescript` package and still uses the `tsc` command. Vite 8 bundles the React 19 frontend.
Route metadata and search indexing use Oxc parsing; they do not need the old JavaScript compiler API.

For an existing project:

```sh
npm uninstall eslint typescript-eslint @typescript-eslint/utils @eslint/js @eslint-react/eslint-plugin eslint-plugin-react-refresh
npm install -D typescript@^7.0.2 oxlint@latest oxlint-tsgolint@latest
```

Replace `eslint.config.js` with `oxlint.config.ts`:

```ts
import toiljs from 'toiljs/oxlint';
export default toiljs;
```

Set `lint` to `oxlint --type-aware client` and keep `typecheck` as `tsc --noEmit`.
The shared preset retains the former strict TypeScript rules, severities, React Hooks checks,
Fast Refresh export exceptions, blank-line rule, and custom byte-array rule. Built-in semantic
rules run in tsgolint; the custom byte-array Oxlint plugin queries the TypeScript 7 native checker.
See [toolchain migration](./typescript7.md) for custom configurations and editor setup.

`toiljs doctor` checks the installed compiler, the declared version range, and type-aware lint
configuration. `doctor --fix` migrates TypeScript declarations to `^7.0.2`. Reinstall afterward.
`toiljs update` only applies TypeScript ranges confined to supported 7.x versions, including when
using `--target patch` on an older project.

## Install the CLI

The package is called `toiljs`, and it provides a command named `toiljs`. You have two ways to use it.

### Option A: run it on demand with npx (no install)

`npx` comes with npm and runs a package without installing it globally. This is the quickest way to create your first project:

```sh
npx toiljs create my-app
```

### Option B: install it globally

If you plan to create projects often, install it once so `toiljs` is always on your path:

```sh
npm install -g toiljs
```

Then you can run `toiljs` directly:

```sh
toiljs create my-app
```

Both options end up at the same place. The rest of these docs write `toiljs <command>`; if you did not install globally, just put `npx` in front (`npx toiljs <command>`).

## Editor setup

After creating your project, run `npm install` inside it. The **Oxc** editor plugin uses the
project's `oxlint` and `oxlint-tsgolint` dependencies to show lint diagnostics and fixes. Use
Node 26 for editor tooling to match toiljs CI. Installing npm dependencies does not install
the editor plugin.

### VS Code

1. Open Extensions and install [Oxc](https://marketplace.visualstudio.com/items?itemName=oxc.oxc-vscode),
   with identifier `oxc.oxc-vscode`. Alternatively, run `code --install-extension oxc.oxc-vscode`.
2. Merge this setting into your project's `.vscode/settings.json`:

   ```json
   {
       "oxc.typeAware": true
   }
   ```

3. If you installed dependencies while the editor was open, run **Oxc: Restart oxlint Server**
   from the Command Palette. Check the **Oxc (Lint)** output channel if it does not start.

New toiljs projects already recommend the extension and enable type-aware linting; you still
need to install the extension. Optional lint fixes on save can be enabled with
`"editor.codeActionsOnSave": { "source.fixAll.oxc": "explicit" }`.

### WebStorm

1. Open **Settings → Plugins → Marketplace**, search for [Oxc](https://plugins.jetbrains.com/plugin/27061-oxc),
   and install it. Restart the IDE if prompted.
2. Set the project's Node.js interpreter to Node 26.
3. Open **Settings → Tools → Oxlint**, select **Automatic configuration**, and check
   **Enable type aware rules**.
4. Apply the settings, then run **Restart Oxlint Server** through Find Action.

The plugin has its own type-aware checkbox, which defaults to off. Its explicit value
[overrides `options.typeAware` in the project config](https://oxc.rs/docs/guide/usage/linter/lsp-config-reference#typeaware),
so installing the plugin alone does not enable tsgolint checks.

If automatic detection does not start the server, select **Manual configuration** and set
**Path to Oxlint Language Server** to `<project>/node_modules/oxlint/bin/oxlint`. Check
**Add --lsp CLI argument** and keep **Enable type aware rules** checked. Use the JavaScript
launcher at that path so `oxlint.config.ts` and the custom JavaScript rules can load.

Leave **Path to Oxlint Config** blank when opening the whole toiljs repository, and leave
**Disable nested config lookups** unchecked, so both examples use their own configurations.
For a standalone app whose config is not discovered, select that app's `oxlint.config.ts`.

The [Oxc editor guide](https://oxc.rs/docs/guide/usage/linter/editors) covers supported editors.
Run `npm run lint` to check the same project rules from a terminal.

## Verify it works

Check the version:

```sh
toiljs --version
```

You should see a version number printed (for example, `0.0.86`).

To see every command and flag, run help:

```sh
toiljs --help
```

Inside a project, there is a deeper health check called **doctor**. It inspects your setup and dependencies and tells you exactly what to fix. You will use it after you create a project, but it is good to know it exists:

```sh
toiljs doctor
```

`toiljs doctor` reads your project (its `package.json`, config, routes, and build output), runs a series of checks, and prints a grouped report. One of the first checks is your Node.js version against the required `>=24.0.0`, so if your Node is too old, doctor will say so. Add `--fix` to let it repair the things it can (such as the typed-RPC wiring), or `--json` for machine-readable output in a CI pipeline.

## How the tooling fits together

The `toiljs` CLI is a friendly front end over two underlying tools. You rarely call them directly, but it helps to know they exist.

```mermaid
flowchart LR
    CLI["toiljs CLI"] --> TS["toilscript<br/>(compiles server/ to wasm)"]
    CLI --> VITE["Vite<br/>(bundles client/ React)"]
    TS --> W["build/server/release.wasm"]
    VITE --> B["build/client/"]
```

When you create a project, both `toiljs` and `toilscript` are added to it as dependencies, so everything is pinned to versions that work together. You do not install `toilscript` separately.

## Gotchas and notes

- **"command not found: toiljs"** after a global install usually means npm's global bin folder is not on your `PATH`. Either fix your `PATH` or just use `npx toiljs ...` instead.
- **Node too old** is the most common first-time failure. WebAssembly tooling and the build depend on features in Node 24 and up. Upgrade before creating a project.
- **Every command checks for updates.** On each run, the CLI quietly checks npm for a newer toiljs and prints a note if you are behind. It never blocks the command. To turn it off, set the environment variable `TOILJS_NO_UPDATE_CHECK=1`.
- You do **not** need to install a database, a Docker container, or any cloud account to develop locally. The dev server includes a local ToilDB so your data-backed features run out of the box.

## Related

- [Create a project](./create-project.md)
- [The CLI reference](../cli/README.md)
- [Getting started overview](./README.md)

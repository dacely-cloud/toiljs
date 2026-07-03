# Create a project

Scaffold a brand-new toiljs app with one command. The CLI asks a few questions, writes the files, and (optionally) installs dependencies for you.

## Why and when

`toiljs create` is how every project starts. It wires up the enforced toiljs presets (TypeScript, ESLint, and Prettier config), the file-based routing, and a working client and server, so you get a project that builds and runs on the first try. Use it for a new app. To bring an **existing** React app into toiljs instead, see [Migrating](./migrating.md).

## The command

```sh
toiljs create my-app
```

Replace `my-app` with your project name (it becomes the folder name). If you leave the name off, the wizard asks for one.

By default this runs an interactive wizard. To skip every question and accept the defaults (handy for scripts and CI), add `--yes`:

```sh
toiljs create my-app --yes
```

## What the wizard asks

Running `toiljs create` walks you through these prompts. Each one has a flag you can pass instead, so you can answer some or all of them up front.

| Prompt | What it decides | Flag | Default |
| --- | --- | --- | --- |
| Project name | The folder and package name | (the first argument) | `my-toil-app` |
| Which template? | How much starter code you get | `-t, --template <app\|minimal>` | `app` |
| Styling | The CSS flavor for `client/` | `--style <css\|sass\|less\|stylus>` | `css` |
| Add Tailwind CSS? | Adds Tailwind on top of the styling | `--tailwind` / `--no-tailwind` | off |
| AI assistant files | Editor hint files for Claude, Cursor, Codex, Copilot | `--no-ai` (to skip) | all |
| Optimize images at build time? | Resize and compress imported images | `--images` / `--no-images` | on |
| Initialize a git repository? | Runs `git init` and stages the files | `--git` / `--no-git` | on |
| Install dependencies now? | Runs your package manager's install | `--install` / `--no-install` | on |

Two more flags do not have a prompt:

- `--pm <npm\|pnpm\|yarn\|bun>` picks the package manager to install with (default `npm`).
- `-y, --yes` accepts every default and runs without any prompts.

### The two templates

- **`app`** (default) is the full starter: a landing page, a shared layout, styles, and a set of demo routes that show off HTTP routes, typed RPC, cookies, auth, and a ToilDB-backed guestbook. Great for learning by reading real, working code.
- **`minimal`** is the bare minimum: a layout, a single home page, and a tiny server handler with one example endpoint. Great when you want a clean slate.

A fully non-interactive example:

```sh
toiljs create my-app --yes --template minimal --style css --no-tailwind --pm pnpm
```

## What gets scaffolded

Here is the shape of a new **`app`** project. The exact set of demo routes may grow over time, so this is trimmed for readability.

```text
my-app/
  package.json            scripts + dependencies (toiljs, react, toilscript, ...)
  toil.config.ts          client/build config (SEO, images, page transitions)
  toilconfig.json         server (wasm) build config for toilscript
  tsconfig.json           TypeScript config for the client
  eslint.config.js        linting preset
  .prettierrc             formatting preset
  .gitignore              ignores build output, generated files, and .env files
  toil-env.d.ts           generated editor types for client globals (Toil.*)
  toil-routes.d.ts        generated typed-route names (filled in on first build)
  README.md
  CLAUDE.md / AGENTS.md   AI assistant hint files (if you kept them)

  client/                 your React app (runs in the browser)
    toil.tsx              the client entry: mounts routes + layout
    layout.tsx            the root layout that wraps every page
    404.tsx               the not-found page
    global-error.tsx      the top-level error page
    routes/               file-based pages (index.tsx = "/", about.tsx = "/about", ...)
    components/           shared React components
    styles/main.css       global styles
    public/               static files served as-is (favicon, robots.txt, images)

  server/                 your backend (compiled to wasm, runs on the edge)
    main.ts               the entry: wires the handler + imports your surface modules
    tsconfig.json         server-only TS config (loads the toilscript editor plugin)
    toil-server-env.d.ts  generated editor types for server globals (Cookie, crypto, ...)
    core/                 your top-level request handler and shared logic
    models/               @data classes (the typed wire types)
    routes/               @rest controllers (HTTP endpoints)
    services/             @service classes and @remote functions (typed RPC)
    migrations/           ToilDB schema migrations (README explains the convention)
    scheduled/            reserved for scheduled tasks

  shared/                 (created by the build)
    server.ts             GENERATED typed client: the Server proxy + @data codecs
```

The **`minimal`** template is the same layout with far fewer files: `client/` has just `layout.tsx`, `routes/index.tsx`, and `styles/main.css`; `server/` has `main.ts` and `core/AppHandler.ts` with a single example endpoint.

A few files are worth calling out now, and the next page ([Project structure](./project-structure.md)) walks through all of them:

- **`shared/server.ts` does not exist yet** in a fresh project. It is generated the first time you run `toiljs dev` or `toiljs build`. That is normal and expected.
- **`toil-routes.d.ts`** starts as a stub and gets filled in with your real route names on the first build, which is what makes `Toil.Link` route names type-check.
- **`.env` and `.env.secrets` are not created** for you. You add them yourself when you need local environment variables or secrets. They are already listed in `.gitignore` so you never commit them. See [Environment and secrets](../services/environment.md).

## Run it

Once scaffolding (and install) finishes, the CLI prints your next steps:

```sh
cd my-app
npm run dev
```

`npm run dev` runs `toiljs dev`, which builds your server to wasm, generates `shared/server.ts`, and starts the dev server with hot reload. Open the printed URL (by default `http://localhost:3000`) and you have a live app.

If you told the wizard **not** to install dependencies, run `npm install` first.

## Gotchas and notes

- **Scaffolding into a non-empty folder** asks for confirmation in interactive mode, and fails in `--yes` mode. Create into a fresh, empty directory.
- **The project name must be a valid package name** and must stay inside the current directory (no `..`, no absolute paths).
- **Git init is best-effort.** If `git` is not installed, the CLI skips that step and keeps going.
- **You do not run `toilscript` yourself.** It is added as a dependency and driven by `toiljs dev` / `toiljs build`.

## Related

- [Project structure](./project-structure.md)
- [Your first app](./first-app.md)
- [The CLI reference](../cli/index.md)
- [Configuration](../concepts/config.md)
- [Styling](../frontend/styling.md)

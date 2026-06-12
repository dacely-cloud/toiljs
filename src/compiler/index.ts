import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

import pc from 'picocolors';
import { build as viteBuild, createServer, mergeConfig, type ViteDevServer } from 'vite';
// The server modules pull in @btc-vision/hyper-express, whose uWebSockets.js native
// addon loads at import time. Only `dev`/`start` need them, so they are imported
// lazily; `create`/`build`/`doctor` must never touch the native binary.
import type { RunningBackend } from 'toiljs/backend';

import { loadConfig } from './config.js';
import { generate } from './generate.js';
import { prerenderStaticParams } from './ssg.js';
import { createViteConfig } from './vite.js';

/**
 * A `@data`/`@rest`/`@service`/`@remote` declaration - a file with one defines client surface.
 * Anchored to line-start (after indentation) so a mention in a comment (e.g. `// the @rest ...`)
 * does not count.
 */
const SURFACE_DECORATOR = /^[ \t]*@(data|rest|service|remote)\b/m;

/** The toilconfig `entries` (relative paths), or `null` when there is no readable toilconfig. */
function toilconfigEntries(root: string): string[] | null {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, 'toilconfig.json'), 'utf8')) as {
            entries?: unknown;
        };
        return Array.isArray(cfg.entries)
            ? cfg.entries.filter((e): e is string => typeof e === 'string')
            : [];
    } catch {
        return null;
    }
}

/** The directories that hold server source (the toilconfig entries' dirs, or `server/`). */
function serverDirs(root: string): string[] {
    const entries = toilconfigEntries(root);
    if (entries === null) return [];
    const dirs = new Set<string>();
    for (const e of entries) dirs.add(path.dirname(path.resolve(root, e)));
    if (dirs.size === 0) dirs.add(path.join(root, 'server'));
    return [...dirs];
}

/**
 * Every server `.ts` source file (under the directories of the toilconfig `entries`, or `server/`
 * by default). Passed to toilscript as explicit entries so a dropped-in `@data`/`@rest` file is
 * compiled - and its surface picked up into `shared/server.ts` - even if the toilconfig lists only
 * `main.ts`. Paths are returned relative to `root`.
 */
function serverEntryFiles(root: string): string[] {
    const entries = toilconfigEntries(root);
    if (entries === null) return [];

    // Start from the toilconfig entries (normalized), then add any server file that declares a
    // surface, so a dropped-in @data/@rest file is compiled even when it is not listed. Non-surface
    // helpers stay out of the entry list - they are still compiled when imported - which also avoids
    // toilscript's "class is not a WebAssembly export" warning for handler classes.
    const result = new Set<string>(entries.map((e) => path.relative(root, path.resolve(root, e))));

    const dirs = serverDirs(root);

    let scanned = 0;
    const cap = 500;
    const visit = (dir: string, depth: number): void => {
        if (scanned >= cap || depth > 16) return;
        let listing: fs.Dirent[];
        try {
            listing = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of listing) {
            if (scanned >= cap) break;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules') visit(full, depth + 1);
            } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                scanned++;
                try {
                    if (SURFACE_DECORATOR.test(fs.readFileSync(full, 'utf8'))) {
                        result.add(path.relative(root, full));
                    }
                } catch {
                    // unreadable: skip
                }
            }
        }
    };
    for (const dir of dirs) visit(dir, 0);
    return [...result].sort();
}

/**
 * Builds the toilscript server target (which also regenerates `shared/server.ts` via
 * `--rpcModule`) when the project has one, signalled by a `toilconfig.json` at the root. This
 * runs before the client build/dev so the generated `@data` + `Server` module the client
 * imports is always current; without it a stale or missing `shared/server.ts` breaks the
 * client build. A no-op for client-only projects. Compiles every server `.ts` file (not just the
 * toilconfig entries) so dropped-in `@data`/`@rest` files are picked up. Runs the locally
 * installed `toilscript`, resolved + invoked via Node (no `.bin` shim / PATH assumptions).
 */
async function buildServer(root: string): Promise<void> {
    if (!fs.existsSync(path.join(root, 'toilconfig.json'))) return;

    const require = createRequire(path.join(root, 'package.json'));
    let binJs: string;
    try {
        const pkgPath = require.resolve('toilscript/package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
            bin?: string | Record<string, string>;
        };
        const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.toilscript;
        if (!binRel) throw new Error('toilscript declares no bin');
        binJs = path.join(path.dirname(pkgPath), binRel);
    } catch {
        throw new Error(
            "toiljs: this project has a server target (toilconfig.json) but 'toilscript' is not " +
                'installed. Run `npm i -D toilscript`, or remove toilconfig.json for a client-only build.',
        );
    }

    // Explicit entries (every server file) override the toilconfig entries; the target options
    // (optimization, features, runtime) still come from the toilconfig's `release` target.
    const files = serverEntryFiles(root);
    const args = [binJs, ...files, '--target', 'release', '--rpcModule', 'shared/server.ts'];

    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0
                ? resolve()
                : reject(new Error(`toilscript server build failed (exit ${String(code)})`)),
        );
    });
}

/**
 * Watches the server source dirs and rebuilds the server (toilscript) on change, so editing a
 * `@data`/`@rest` file under `toiljs dev` regenerates `shared/server.ts` - which Vite then HMRs
 * into the client - and the dev server hot-swaps the recompiled wasm: the server-side equivalent
 * of Vite's client HMR. Client-only edits never touch these dirs, so they only trigger Vite,
 * never a server rebuild. Rebuilds are debounced and never overlap. Rides Vite's chokidar
 * watcher instead of a separate `fs.watch`: the native recursive watcher silently stops
 * delivering events on Linux after editors replace files via rename, which left hot reload
 * working exactly once. A no-op for client-only projects.
 */
function watchServer(root: string, watcher: ViteDevServer['watcher']): void {
    const dirs = serverDirs(root);
    if (dirs.length === 0) return;

    let building = false;
    let queued = false;
    const rebuild = (): void => {
        if (building) {
            queued = true;
            return;
        }
        building = true;
        process.stdout.write(pc.dim('  server changed, rebuilding…') + '\n');
        buildServer(root)
            .then(() => process.stdout.write(pc.green('  ✓ ') + pc.dim('server rebuilt') + '\n'))
            .catch((e: unknown) =>
                process.stdout.write(pc.red(`  ✗ server rebuild failed: ${String(e)}`) + '\n'),
            )
            .finally(() => {
                building = false;
                if (queued) {
                    queued = false;
                    rebuild();
                }
            });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const isServerSource = (file: string): boolean =>
        file.endsWith('.ts') &&
        !file.endsWith('.d.ts') &&
        dirs.some((dir) => file === dir || file.startsWith(dir + path.sep));
    watcher.add(dirs);
    watcher.on('all', (_event, file) => {
        if (!isServerSource(file)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(rebuild, 150); // debounce bursts (save-all, formatters)
    });
}

/** The server wasm artifact path from the toilconfig `release` target (toilscript's output). */
function serverWasmFile(root: string): string {
    let outFile = 'build/server/release.wasm';
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, 'toilconfig.json'), 'utf8')) as {
            targets?: Record<string, { outFile?: string }>;
        };
        outFile = cfg.targets?.release?.outFile ?? outFile;
    } catch {
        // No readable toilconfig: caller already gated on its existence; keep the default.
    }
    return path.resolve(root, outFile);
}

/** An OS-assigned free loopback port (for the internal Vite server behind the dev front). */
async function freeLoopbackPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            if (address === null || typeof address === 'string') {
                probe.close();
                reject(new Error('could not allocate a loopback port'));
                return;
            }
            probe.close(() => resolve(address.port));
        });
    });
}

export interface ToilCommandOptions {
    readonly root?: string;
    readonly port?: number;
    /** Bind host for `start`. Defaults to loopback (`127.0.0.1`); pass `0.0.0.0` to expose. */
    readonly host?: string;
    /** `build` only: build the server (regenerate `shared/server.ts` + the wasm) and skip the client. */
    readonly serverOnly?: boolean;
}

/**
 * Starts the dev server. Client-only projects get the plain Vite dev server on
 * the configured port, unchanged. Projects with a server target
 * (toilconfig.json) get the WASM dev server in front: a uWebSockets.js server
 * on the configured port that dispatches requests into the ToilScript server
 * wasm (same envelope ABI as the production edge) and transparently proxies
 * everything the server does not claim, HMR websocket included, to a Vite dev
 * server on an internal loopback port. Vite keeps 100% of its dev behavior;
 * it just stops being the public listener. Returns the running Vite server.
 */
export async function dev(opts: ToilCommandOptions = {}): Promise<ViteDevServer> {
    const cfg = await loadConfig(opts);
    // Server first: build it (regenerating shared/server.ts) before the client dev server starts.
    const hasServer = fs.existsSync(path.join(cfg.root, 'toilconfig.json'));
    if (hasServer) process.stdout.write(pc.dim('  building the server (toilscript)…') + '\n');
    await buildServer(cfg.root);
    if (hasServer) process.stdout.write(pc.green('  ✓ ') + pc.dim('server built') + '\n');
    generate(cfg);

    if (!hasServer) {
        const server = await createServer(await createViteConfig(cfg));
        await server.listen();
        server.printUrls();
        return server;
    }

    // Vite moves to an internal loopback port; the WASM dev server takes the public one.
    const vitePort = await freeLoopbackPort();
    const viteConfig = mergeConfig(await createViteConfig(cfg), {
        server: { port: vitePort, host: '127.0.0.1', strictPort: true },
    });
    const server = await createServer(viteConfig);
    await server.listen();

    const { startDevServer } = await import('toiljs/devserver');
    const front = await startDevServer({
        root: cfg.root,
        port: cfg.port,
        wasmFile: serverWasmFile(cfg.root),
        vite: { host: '127.0.0.1', port: vitePort },
    });
    server.httpServer?.once('close', () => {
        void front.close();
    });
    process.stdout.write(
        '\n  ' +
            pc.green('➜') +
            '  ' +
            pc.bold('Local') +
            ':   ' +
            pc.cyan(`http://localhost:${pc.bold(String(front.port))}/`) +
            pc.dim('  (wasm server + vite)') +
            '\n',
    );

    // Rebuild the server on server-file changes; Vite HMRs the regenerated shared/server.ts
    // and the dev server hot-swaps the recompiled wasm module.
    watchServer(cfg.root, server.watcher);
    return server;
}

/** Produces an optimized production SPA bundle in the configured `outDir`. With `serverOnly`,
 *  builds just the server (regenerates `shared/server.ts` + the wasm) and skips the client. */
export async function build(opts: ToilCommandOptions = {}): Promise<void> {
    const cfg = await loadConfig(opts);
    // The server is always built first so the client's generated `shared/server.ts` is current.
    // toilscript is quiet on success, so announce the step explicitly (otherwise it looks skipped).
    // For `serverOnly` the CLI narrates the step, so stay quiet here to avoid doubling up.
    const hasServer = fs.existsSync(path.join(cfg.root, 'toilconfig.json'));
    if (hasServer && !opts.serverOnly)
        process.stdout.write(pc.dim('  building the server (toilscript)…') + '\n');
    await buildServer(cfg.root);
    if (opts.serverOnly) return;
    if (hasServer)
        process.stdout.write(
            pc.green('  ✓ ') + pc.dim('server built; building the client (vite)…') + '\n',
        );
    generate(cfg);
    await viteBuild(await createViteConfig(cfg));
    // SSG: bake per-URL HTML + sitemap for dynamic routes that opt in via `generateStaticParams`.
    await prerenderStaticParams(cfg);
}

/**
 * Self-hosts the built client over the high-performance hyper-express backend (uWebSockets.js),
 * serving the configured `outDir` with an SPA fallback plus a WebSocket channel. Requires a prior
 * `build`. Returns the running backend.
 */
export async function start(opts: ToilCommandOptions = {}): Promise<RunningBackend> {
    const cfg = await loadConfig(opts);
    const outDir = path.resolve(cfg.root, cfg.outDir);
    if (!fs.existsSync(path.join(outDir, 'index.html'))) {
        throw new Error(`No build found in ${outDir}. Run \`toiljs build\` first.`);
    }
    const { startBackend } = await import('toiljs/backend');
    return startBackend({ root: outDir, port: cfg.port, host: opts.host });
}

export { defineConfig, loadConfig, AiProvider } from './config.js';
export { scanRoutes } from './routes.js';
export type { ScannedRoute } from './routes.js';
export { TOIL_ENV_DTS } from './generate.js';
export { AI_HELPERS, AI_HELPER_IDS, aiHelperFiles, TOIL_DOCS } from './docs.js';
export type { AiHelper } from './docs.js';
export type {
    ToilConfig,
    ResolvedToilConfig,
    ClientConfig,
    ServerConfig,
    DevtoolsConfig,
    DevtoolsAiConfig,
} from './config.js';
export type { RunningBackend, BackendOptions } from 'toiljs/backend';

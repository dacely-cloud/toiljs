import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

import pc from 'picocolors';
import { build as viteBuild, createServer, mergeConfig, type ViteDevServer } from 'vite';
// The server modules pull in @dacely/hyper-express, whose uWebSockets.js native
// addon loads at import time. Only `dev`/`start` need them, so they are imported
// lazily; `create`/`build`/`doctor` must never touch the native binary.
import type { RunningBackend } from 'toiljs/backend';

import { loadConfig, type ResolvedToilConfig } from './config.js';
import { renderEmails } from './emails.js';
import { generate, TOIL_SERVER_ENV_DTS } from './generate.js';
import { prerenderStaticParams } from './ssg.js';
import { extractServerSlots, extractTemplates } from './template-build.js';
import { createViteConfig } from './vite.js';

/**
 * A surface declaration - a file with one defines client and/or server surface, so it must be
 * handed to toilscript even when it is not a `toilconfig.json` entry. Matches the request/RPC
 * surface (`@data`/`@rest`/`@service`/`@remote`) and the streams/daemon surface
 * (`@stream`/`@daemon`/`@scheduled`); without the latter, a file whose ONLY decorator is `@daemon`
 * or `@scheduled` would silently vanish from the cold artifact. Anchored to line-start (after
 * indentation) so a mention in a comment (e.g. `// the @rest ...`) does not count.
 */
export const SURFACE_DECORATOR = /^[ \t]*@(data|rest|service|remote|stream|daemon|scheduled)\b/m;

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
export async function buildServer(root: string): Promise<void> {
    if (!fs.existsSync(path.join(root, 'toilconfig.json'))) return;

    // Regenerate the editor-only server-globals d.ts each build (the same way
    // `generate` rewrites `toil-env.d.ts`), so an existing project auto-migrates
    // to the current shapes without re-scaffolding or running doctor. Best
    // effort; an unwritable dir never blocks the build.
    for (const dir of serverDirs(root)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'toil-server-env.d.ts'), TOIL_SERVER_ENV_DTS);
        } catch {
            // editor-only; ignore write failures
        }
    }

    const binJs = resolveToilscriptBin(root);

    // Explicit entries (every server file) override the toilconfig entries; the target options
    // (optimization, features, runtime) still come from the toilconfig's `release` target.
    const files = serverEntryFiles(root);

    // A project that declares a `@daemon` (cold surface) compiles the ONE source tree into TWO
    // artifacts via two toilscript passes (one per --targetMode); a project with only the legacy
    // request surface keeps the single-artifact path (byte-identical to before). The cold pass
    // runs FIRST (cheap, no client surface); the hot pass runs LAST because it (re)writes
    // shared/server.ts via --rpcModule, which the downstream client build imports.
    const split = splitSurfaceFiles(root, files);
    if (split.hasDaemon) {
        const artifacts = serverArtifacts(root);
        // toilscript's gating matrix HARD-ERRORS a `@daemon`/`@scheduled` class compiled under
        // `--targetMode hot` (and a `@rest`/`@stream`/`@service`/`@remote` class under cold). So
        // each pass is handed only the files eligible for that mode: the cold pass drops hot-only
        // files, the hot pass drops daemon-only files. `@data`/`@database`/plain files are shared.
        await runToilscriptPass(root, binJs, split.cold, {
            mode: 'cold',
            outFile: artifacts.cold,
            withRpc: false,
        });
        // The hot pass writes the legacy `outFile` (= hotFile alias, AN-1) so the request path
        // and the dev server's `serverWasmFile` are unchanged; the request box loads it as today.
        // A daemon-only project (no request/stream surface) has no hot files; skip the hot pass so
        // toilscript is not handed an empty entry set. The request path then stays idle (no
        // `handle` export), which is correct for a pure background worker.
        if (split.hot.length > 0)
            await runToilscriptPass(root, binJs, split.hot, {
                mode: 'hot',
                outFile: serverWasmFile(root),
                withRpc: true,
            });
        return;
    }

    // Legacy single-artifact path (no daemon surface): exactly today's invocation.
    await runToilscriptPass(root, binJs, files, { mode: null, outFile: null, withRpc: true });
}

/** Resolve the locally installed `toilscript` bin via Node (no `.bin` shim / PATH assumptions). */
function resolveToilscriptBin(root: string): string {
    const require = createRequire(path.join(root, 'package.json'));
    try {
        const pkgPath = require.resolve('toilscript/package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
            bin?: string | Record<string, string>;
        };
        const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.toilscript;
        if (!binRel) throw new Error('toilscript declares no bin');
        return path.join(path.dirname(pkgPath), binRel);
    } catch {
        throw new Error(
            "toiljs: this project has a server target (toilconfig.json) but 'toilscript' is not " +
                'installed. Run `npm i -D toilscript`, or remove toilconfig.json for a client-only build.',
        );
    }
}

/** Files classified per target mode for the two-pass build. */
interface SurfaceSplit {
    /** Whether any file declares a `@daemon` (so a cold pass is needed at all). */
    readonly hasDaemon: boolean;
    /** Files eligible for the COLD pass (everything except hot-only request files). */
    readonly cold: string[];
    /** Files eligible for the HOT pass (everything except daemon-only cold files). */
    readonly hot: string[];
}

/** A `@daemon`/`@scheduled` decorator at line start (a cold-only surface). */
const COLD_DECORATOR = /^[ \t]*@(daemon|scheduled)\b/m;
/** A request/stream-surface decorator at line start (a hot-only surface). */
const HOT_DECORATOR = /^[ \t]*@(rest|route|stream|service|remote)\b/m;

/**
 * Classify each server source file by the surface decorators it declares, so each toilscript pass
 * is handed only the files valid for its `--targetMode` (toilscript HARD-ERRORS a cold class in
 * the hot artifact and vice versa). A file with a cold-only surface (`@daemon`/`@scheduled` and no
 * hot decorator) is dropped from the hot pass; a file with a hot-only surface is dropped from the
 * cold pass. Shared files (`@data`/`@database`/plain helpers, or a file mixing both surfaces) stay
 * in both passes, matching toilscript's class-level gating which admits `@data`/`@database`
 * everywhere.
 */
export function splitSurfaceFiles(root: string, files: string[]): SurfaceSplit {
    let hasDaemon = false;
    const cold: string[] = [];
    const hot: string[] = [];
    for (const rel of files) {
        let src = '';
        try {
            src = fs.readFileSync(path.join(root, rel), 'utf8');
        } catch {
            // unreadable: keep it in both passes (let toilscript surface the error).
            cold.push(rel);
            hot.push(rel);
            continue;
        }
        const isCold = COLD_DECORATOR.test(src);
        const isHot = HOT_DECORATOR.test(src);
        if (isCold) hasDaemon ||= /^[ \t]*@daemon\b/m.test(src);
        // Drop a file from the hot pass only when it is cold-only (cold surface, no hot surface);
        // a mixed file stays in both (toilscript gates per class, not per file).
        if (!(isCold && !isHot)) hot.push(rel);
        // Drop a file from the cold pass only when it is hot-only.
        if (!(isHot && !isCold)) cold.push(rel);
    }
    return { hasDaemon, cold, hot };
}

interface PassOptions {
    /** `--targetMode` value; `null` keeps the legacy single-artifact invocation (no flag). */
    readonly mode: 'hot' | 'cold' | null;
    /** Explicit `--outFile` for a two-pass build; `null` uses the toilconfig default. */
    readonly outFile: string | null;
    /** Only the hot/legacy pass carries `--rpcModule` (the cold artifact has no client surface). */
    readonly withRpc: boolean;
}

/** Run one toilscript pass. The toilscript CLI flag is `--targetMode` (camelCase). */
function runToilscriptPass(
    root: string,
    binJs: string,
    files: string[],
    opts: PassOptions,
): Promise<void> {
    // Suppress AS235 ("only variables/functions/enums become wasm exports"): a `@data`/`@rest`
    // class is intentionally `export class` (so other server files import it), but never a wasm
    // export — the warning is pure noise here.
    const args = [binJs, ...files, '--target', 'release'];
    if (opts.mode !== null) args.push('--targetMode', opts.mode);
    if (opts.outFile !== null) args.push('--outFile', opts.outFile);
    if (opts.withRpc) args.push('--rpcModule', 'shared/server.ts');
    args.push('--disableWarning', '235');

    return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0
                ? resolve()
                : reject(
                      new Error(
                          `toilscript ${opts.mode ?? 'release'} build failed (exit ${String(code)})`,
                      ),
                  ),
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
function watchServer(cfg: ResolvedToilConfig, watcher: ViteDevServer['watcher']): void {
    const root = cfg.root;
    const dirs = serverDirs(root);
    if (dirs.length === 0) return;
    const emailsDir = path.join(root, 'emails');

    let building = false;
    let queued = false;
    const rebuild = (): void => {
        if (building) {
            queued = true;
            return;
        }
        building = true;
        process.stdout.write(pc.dim('  server changed, rebuilding…') + '\n');
        // Recompile emails/*.tsx -> the generated module before the server build,
        // so editing an email template hot-reloads like any other server change.
        renderEmails(cfg)
            .then(() => buildServer(root))
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
        // `_emails.ts` is GENERATED by renderEmails on every rebuild; reacting to
        // our own output would loop forever (rebuild -> write -> rebuild -> ...).
        path.basename(file) !== '_emails.ts' &&
        dirs.some((dir) => file === dir || file.startsWith(dir + path.sep));
    const isEmailSource = (file: string): boolean =>
        /\.(tsx|jsx)$/.test(file) && (file === emailsDir || file.startsWith(emailsDir + path.sep));
    // A transient watch error must NOT crash the dev server: an unhandled 'error'
    // on the chokidar watcher takes down the whole process. Windows throws EBUSY /
    // EPERM when a file is momentarily locked (an editor save, a formatter, our own
    // rebuild, a just-written file). Swallow it — the next change still fires.
    watcher.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(pc.yellow('  ! ') + pc.dim(`file watcher: ${msg}`) + '\n');
    });
    watcher.add([...dirs, emailsDir]);
    watcher.on('all', (_event, file) => {
        if (!isServerSource(file) && !isEmailSource(file)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(rebuild, 150); // debounce bursts (save-all, formatters)
    });
}

/**
 * Make `Ctrl+C` actually kill the dev server. Without this the process can hang
 * on shutdown (the native uWebSockets listener / Vite's watcher don't always
 * close promptly), so an old `toiljs dev` is left ORPHANED — still watching and
 * rebuilding — and the next run races it (parallel double rebuilds), while the
 * console is left with a hidden cursor. On SIGINT/SIGTERM we restore the cursor,
 * close the servers, and force-exit after a short grace period no matter what.
 */
function installDevShutdown(close: () => Promise<void> | void): void {
    // Final, SYNCHRONOUS terminal restore — `exit` runs no matter how we go
    // (signal, throw, normal), so the console can't be left in a broken state.
    const restoreTerminal = (): void => {
        // Cooked input mode back. This is the important one on Windows: if anything
        // in the dev stack (a dep that reads stdin, or libuv) left stdin in raw /
        // VT-input mode, our force-exit below skips the automatic tty reset, and
        // cmd is left echoing arrow keys as `^[[A` and mis-reading typed input.
        // `setRawMode(false)` forces the console back to normal line editing.
        try {
            const stdin = process.stdin;
            if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
        } catch {
            /* not a TTY / already torn down */
        }
        // Show the cursor and reset styles (a build spinner may have hidden it).
        try {
            process.stdout.write('\x1b[0m\x1b[?25h');
        } catch {
            /* stream already closed */
        }
    };
    process.on('exit', restoreTerminal);

    let closing = false;
    const shutdown = (): void => {
        if (closing) return;
        closing = true;
        restoreTerminal();
        process.stdout.write(pc.dim('\n  shutting down dev server…') + '\n');
        // Force-exit even if a server hangs on close (the orphan-prevention).
        const hard = setTimeout(() => process.exit(0), 1500);
        hard.unref();
        Promise.resolve()
            .then(close)
            .catch(() => {})
            .finally(() => process.exit(0));
    };
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, shutdown);
}

/** The server wasm artifact path from the toilconfig `release` target (toilscript's output).
 *  This is the LEGACY single-artifact path (= the hot artifact under the two-pass build). */
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

/** The hot + cold artifact paths for the two-pass build. `hotFile`/`coldFile` are honored when
 *  present in the toilconfig `release` target; otherwise derived from `outFile` by inserting the
 *  mode before the extension (`release.wasm` -> `release-hot.wasm` / `release-cold.wasm`). */
export interface ServerArtifacts {
    /** Absolute path to the hot (request/stream) artifact. */
    readonly hot: string;
    /** Absolute path to the cold (daemon) artifact. */
    readonly cold: string;
}
export function serverArtifacts(root: string): ServerArtifacts {
    let out = 'build/server/release.wasm';
    let hot: string | undefined;
    let cold: string | undefined;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, 'toilconfig.json'), 'utf8')) as {
            targets?: Record<string, { outFile?: string; hotFile?: string; coldFile?: string }>;
        };
        out = cfg.targets?.release?.outFile ?? out;
        hot = cfg.targets?.release?.hotFile;
        cold = cfg.targets?.release?.coldFile;
    } catch {
        // No readable toilconfig: caller already gated on its existence; keep defaults.
    }
    const ins = (mode: 'hot' | 'cold'): string => {
        const ext = path.extname(out);
        return out.slice(0, ext ? -ext.length : undefined) + '-' + mode + (ext || '.wasm');
    };
    return {
        hot: path.resolve(root, hot ?? ins('hot')),
        cold: path.resolve(root, cold ?? ins('cold')),
    };
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

/** Prints the email-preview URL under the dev banner, when the project has an
 *  `emails/` folder. `localUrl` is the resolved base (ends in `/`); skipped if
 *  the server didn't report one. */
function printEmailsUrl(cfg: ResolvedToilConfig, localUrl: string | undefined): void {
    if (!localUrl || !fs.existsSync(path.join(cfg.root, 'emails'))) return;
    process.stdout.write(
        '  ' +
            pc.green('✉') +
            '  ' +
            pc.bold('Emails') +
            ':  ' +
            pc.cyan(`${localUrl}__toil/emails`) +
            pc.dim('  (preview)') +
            '\n',
    );
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
    // Compile emails/*.tsx -> generated server module BEFORE toilscript builds it in.
    await renderEmails(cfg);
    // Generate the client codegen first so the SSR slots pre-pass can load the route graph, then
    // emit the server-importable `<server>/_ssr/<name>.slots.ts` BEFORE the server build so its
    // `render` can import them. Dev reuses the prior build's shell (or the template) for the HASH;
    // `dispatchRender` checks coherence against the same `.slots`, so a hash drift surfaces as the
    // documented fail-safe 500 until the next full `build`. A no-op without an `ssr = true` route.
    generate(cfg);
    if (hasServer) await extractServerSlots(cfg);
    await buildServer(cfg.root);
    if (hasServer) process.stdout.write(pc.green('  ✓ ') + pc.dim('server built') + '\n');

    if (!hasServer) {
        const server = await createServer(await createViteConfig(cfg));
        await server.listen();
        server.printUrls();
        printEmailsUrl(cfg, server.resolvedUrls?.local?.[0]);
        installDevShutdown(() => server.close());
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
        // The daemon (cold) emulator drives `release-cold.wasm` per `nodeMode`; absent for a
        // project with no `@daemon` (the cold artifact never gets built, so the host stays idle).
        coldWasmFile: serverArtifacts(cfg.root).cold,
        nodeMode: cfg.nodeMode,
        daemon: cfg.daemon,
        vite: { host: '127.0.0.1', port: vitePort },
        email: cfg.email ?? undefined,
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
    printEmailsUrl(cfg, `http://localhost:${String(front.port)}/`);

    // Rebuild the server on server-file changes; Vite HMRs the regenerated shared/server.ts
    // and the dev server hot-swaps the recompiled wasm module.
    watchServer(cfg, server.watcher);
    installDevShutdown(async () => {
        await front.close();
        await server.close();
    });
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
    // Compile emails/*.tsx -> generated server module BEFORE toilscript builds it in.
    await renderEmails(cfg);
    // Generate the client codegen (`.toil/globals.ts`, `.toil/index.html`, …) NOW — before the
    // server build — so the SSR slots pre-pass below can load the route/layout module graph and
    // render the opted-in routes.
    generate(cfg);
    // SSR slots PRE-PASS: emit the server-importable `<server>/_ssr/<name>.slots.ts` (the `Slot`
    // enum + `HASH`) the guest `render` imports, so toilscript can compile it. This is what makes a
    // CLEAN build work with zero hand-maintained slots: the modules are generated here, before the
    // server compiles. (The `HASH` is finalized by the post-Vite `extractTemplates` below, which
    // recompiles the server only if it rotated.) A no-op for a project with no `ssr = true` route.
    const priorServerSlots = hasServer ? await extractServerSlots(cfg) : new Map<string, string>();
    await buildServer(cfg.root);
    if (opts.serverOnly) return;
    if (hasServer)
        process.stdout.write(
            pc.green('  ✓ ') + pc.dim('server built; building the client (vite)…') + '\n',
        );
    await viteBuild(await createViteConfig(cfg));
    // SSG: bake per-URL HTML + sitemap for dynamic routes that opt in via `generateStaticParams`.
    await prerenderStaticParams(cfg);
    // Edge SSR: render `export const ssr = true` routes to template-with-holes
    // (`_ssr/*.tmpl|slots` + the guest `Slot` module), copied into the edge host
    // bundle. This also rewrites the server-importable slots module against the REAL built shell
    // (authoritative `HASH`). No-op when no route opts in.
    const ssr = await extractTemplates(cfg, 'edge', priorServerSlots);
    // If the authoritative `HASH` (or `Slot` ids) rotated since the pre-pass the server was
    // compiled against, recompile the server ONCE so the guest bakes the deployed hash; otherwise
    // the host rejects the response as a deploy skew. The common case (an unchanged rebuild) reuses
    // the prior shell in the pre-pass, so the hashes already match and this is skipped.
    if (ssr.serverSlotsChanged) {
        process.stdout.write(
            pc.dim('  SSR template changed; recompiling the server with the new hash…') + '\n',
        );
        await buildServer(cfg.root);
    }
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
export { TOIL_ENV_DTS, TOIL_SERVER_ENV_DTS } from './generate.js';
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

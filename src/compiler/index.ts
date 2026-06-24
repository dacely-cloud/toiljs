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
import {
    type DevSsrTemplate,
    extractDevSsrTemplates,
    extractServerSlots,
    extractTemplates,
} from './template-build.js';
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

    // A project that declares a `@daemon` (L4 cold surface) and/or a `@stream` (L2/L3 stream
    // surface) compiles the ONE source tree into SEPARATE artifacts, one per deployment tier, via
    // one toilscript pass each; a project with only the request surface keeps the default
    // single-artifact path. The three tiers:
    //   - REQUEST (L1)   `server/main.ts`    + `@rest`/`@service`/`@remote` -> `release.wasm`
    //   - STREAM  (L2/L3) `server/main.stream.ts` + `@stream`              -> `release-stream.wasm`
    //   - DAEMON  (L4)   `@daemon`/`@scheduled`                            -> `release-cold.wasm`
    // toilscript's gating matrix HARD-ERRORS a class compiled under the wrong --targetMode, so each
    // pass is handed only the files eligible for its tier (`@data`/`@database`/plain helpers are
    // SHARED into every pass). The request pass runs LAST because it (re)writes shared/server.ts via
    // --rpcModule, which the downstream client build imports.
    const split = splitSurfaceFiles(root, files);
    if (split.hasDaemon || split.hasStream) {
        const artifacts = serverArtifacts(root);
        // DAEMON (cold) pass: --targetMode cold, no client RPC surface.
        if (split.hasDaemon)
            await runToilscriptPass(root, binJs, split.cold, {
                mode: 'cold',
                outFile: artifacts.cold,
                withRpc: false,
            });
        // STREAM pass: --targetMode hot into its OWN `release-stream.wasm`, no client RPC surface
        // (a resident stream box exposes `stream_dispatch`, not the request client surface). Driven
        // by `server/main.stream.ts` + the `@stream` classes; the request box never loads it.
        if (split.hasStream && split.stream.length > 0)
            await runToilscriptPass(root, binJs, split.stream, {
                mode: 'hot',
                outFile: artifacts.stream,
                withRpc: false,
            });
        // REQUEST pass: the L1 artifact (= `outFile`), WITH the client RPC surface.
        // A pure daemon/stream project (no request files) skips it so toilscript is not handed an
        // empty entry set; the request path then stays idle (no `handle` export), correct for a
        // background-only worker.
        if (split.request.length > 0)
            await runToilscriptPass(root, binJs, split.request, {
                mode: 'hot',
                outFile: serverWasmFile(root),
                withRpc: true,
            });
        return;
    }

    // Default request-only single-artifact path (no daemon/stream surface).
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

/** Files classified per deployment TIER for the multi-artifact build. */
interface SurfaceSplit {
    /** Whether any file declares a `@daemon` (so a cold/daemon pass is needed at all). */
    readonly hasDaemon: boolean;
    /** Whether any file declares a `@stream` (or is a `*.stream.ts` entry), so a stream pass is needed. */
    readonly hasStream: boolean;
    /** Files for the DAEMON (cold) pass: `@daemon`/`@scheduled` surfaces + shared helpers. */
    readonly cold: string[];
    /** Files for the STREAM pass: `@stream` surfaces + the `*.stream.ts` entry + shared helpers. */
    readonly stream: string[];
    /** Files for the REQUEST pass: `@rest`/`@service`/`@remote` surfaces + the request entry + shared helpers. */
    readonly request: string[];
}

/** A `@daemon`/`@scheduled` decorator at line start (the L4 cold/daemon surface). */
const COLD_DECORATOR = /^[ \t]*@(daemon|scheduled)\b/m;
/** A `@stream` decorator at line start (the L2/L3 stream surface). */
const STREAM_DECORATOR = /^[ \t]*@stream\b/m;
/** A request-surface decorator at line start (`@rest`/`@route`/`@service`/`@remote`, the L1 tier). */
const REQUEST_DECORATOR = /^[ \t]*@(rest|route|service|remote)\b/m;
/** A server ENTRY re-exports the runtime WASM entry points; this marks `main.ts` / `main.stream.ts`
 *  (vs a plain `@data`/helper), so each entry is routed to exactly ONE tier and two entries never
 *  collide on a duplicate `export *` in the same pass. */
const RUNTIME_ENTRY = /from\s+['"]toiljs\/server\/runtime\/exports['"]/;

/** True for a STREAM-tier entry by the `*.stream.ts` naming convention (e.g. `main.stream.ts`). */
function isStreamEntryFile(rel: string): boolean {
    return rel.endsWith('.stream.ts');
}

/** True for a COLD/daemon-tier entry by the `*.daemon.ts` naming convention (e.g. `main.daemon.ts`). */
function isDaemonEntryFile(rel: string): boolean {
    return rel.endsWith('.daemon.ts');
}

/**
 * Classify each server source file by its deployment TIER, so each toilscript pass is handed only
 * the files valid for its `--targetMode` (toilscript HARD-ERRORS a class compiled under the wrong
 * mode). Three tiers:
 *   - COLD/daemon: a file declaring `@daemon`/`@scheduled` -> `release-cold.wasm`.
 *   - STREAM (L2/L3): a file declaring `@stream`, OR a `*.stream.ts` entry (`main.stream.ts`) ->
 *     `release-stream.wasm`.
 *   - REQUEST (L1): a file declaring `@rest`/`@service`/`@remote`, OR a non-`*.stream.ts` runtime
 *     ENTRY (`main.ts`) -> `release.wasm`.
 * A file with NONE of these (a plain `@data`/`@database`/helper) is SHARED into every pass, matching
 * toilscript's class-level gating. Routing each entry to exactly one tier keeps `release.wasm` free
 * of `stream_dispatch` and stops two entries re-exporting the runtime in the same pass.
 */
export function splitSurfaceFiles(root: string, files: string[]): SurfaceSplit {
    let hasDaemon = false;
    let hasStream = false;
    const cold: string[] = [];
    const stream: string[] = [];
    const request: string[] = [];
    for (const rel of files) {
        let src = '';
        try {
            src = fs.readFileSync(path.join(root, rel), 'utf8');
        } catch {
            // unreadable: keep it in EVERY pass (let toilscript surface the error).
            cold.push(rel);
            stream.push(rel);
            request.push(rel);
            continue;
        }
        const isCold = COLD_DECORATOR.test(src) || isDaemonEntryFile(rel);
        const isStream = STREAM_DECORATOR.test(src) || isStreamEntryFile(rel);
        const isRequest =
            REQUEST_DECORATOR.test(src) ||
            (RUNTIME_ENTRY.test(src) && !isStreamEntryFile(rel) && !isDaemonEntryFile(rel));
        if (isCold) hasDaemon ||= /^[ \t]*@daemon\b/m.test(src) || isDaemonEntryFile(rel);
        if (isStream) hasStream = true;
        // A file with no tier-specific surface is a SHARED helper, compiled into every pass.
        const shared = !isCold && !isStream && !isRequest;
        if (isCold || shared) cold.push(rel);
        if (isStream || shared) stream.push(rel);
        if (isRequest || shared) request.push(rel);
    }
    return { hasDaemon, hasStream, cold, stream, request };
}

interface PassOptions {
    /** `--targetMode` value; `null` keeps the default request-artifact invocation (no flag). */
    readonly mode: 'hot' | 'cold' | null;
    /** Explicit `--outFile` for a two-pass build; `null` uses the toilconfig default. */
    readonly outFile: string | null;
    /** Only the hot/default request pass carries `--rpcModule` (the cold artifact has no client surface). */
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
    // Each pass is handed its OWN entry subset (the per-tier `files`); suppress the toilconfig
    // `entries` so toilscript does not ALSO append every project entry to every pass (which would
    // pull, e.g., a `@stream` class into the cold daemon pass). serverEntryFiles already folds
    // config.entries into `files`, so no entry is lost by ignoring them here.
    args.push('--noConfigEntries');
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
 *  This is the default request artifact path (= the hot artifact under the two-pass build). */
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
    /** Absolute path to the hot (request) artifact. */
    readonly hot: string;
    /** Absolute path to the cold (daemon) artifact. */
    readonly cold: string;
    /** Absolute path to the stream (L2/L3 `@stream`) artifact (`release-stream.wasm`). */
    readonly stream: string;
}
export function serverArtifacts(root: string): ServerArtifacts {
    let out = 'build/server/release.wasm';
    let hot: string | undefined;
    let cold: string | undefined;
    let stream: string | undefined;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, 'toilconfig.json'), 'utf8')) as {
            targets?: Record<
                string,
                { outFile?: string; hotFile?: string; coldFile?: string; streamFile?: string }
            >;
        };
        out = cfg.targets?.release?.outFile ?? out;
        hot = cfg.targets?.release?.hotFile;
        cold = cfg.targets?.release?.coldFile;
        stream = cfg.targets?.release?.streamFile;
    } catch {
        // No readable toilconfig: caller already gated on its existence; keep defaults.
    }
    const ins = (mode: 'hot' | 'cold' | 'stream'): string => {
        const ext = path.extname(out);
        return out.slice(0, ext ? -ext.length : undefined) + '-' + mode + (ext || '.wasm');
    };
    return {
        hot: path.resolve(root, hot ?? ins('hot')),
        cold: path.resolve(root, cold ?? ins('cold')),
        stream: path.resolve(root, stream ?? ins('stream')),
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
/** Stylesheet module ids (incl. preprocessors), to find CSS in the module graph. */
const DEV_CSS_RE = /\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)(\?|$)/;

/**
 * Collects the CSS reachable from the dev client entry (`/entry.tsx`) by walking Vite's module graph
 * over static imports, then fetching each stylesheet's raw text (`?direct`). The dev SSR shell INLINES
 * this so the server-rendered first paint is styled with NO extra request: a render-blocking `<link>`
 * would otherwise stall the paint while Vite cold-transforms+serves the CSS (a visible blank beat on a
 * cold load). Best-effort + transitive; returns '' if the entry can't be walked.
 */
async function collectDevCss(server: ViteDevServer): Promise<string> {
    const ENTRY = '/entry.tsx';
    const cssUrls = new Set<string>();
    const seen = new Set<string>();
    try {
        await server.transformRequest(ENTRY);
    } catch {
        return '';
    }
    const entry = await server.moduleGraph.getModuleByUrl(ENTRY);
    if (!entry) return '';
    const queue = [entry];
    while (queue.length > 0) {
        const mod = queue.shift();
        if (!mod || mod.id === null || seen.has(mod.id)) continue;
        seen.add(mod.id);
        // Transform (once) so the module's imports are populated in the graph.
        if (!mod.transformResult && mod.url) {
            try {
                await server.transformRequest(mod.url);
            } catch {
                continue;
            }
        }
        for (const dep of mod.importedModules) {
            if (dep.id === null) continue;
            if (DEV_CSS_RE.test(dep.id)) {
                if (dep.url) cssUrls.add(dep.url);
            } else if (!seen.has(dep.id)) {
                queue.push(dep);
            }
        }
    }
    // Extract each stylesheet's real CSS from its normal (non-`?direct`) module. Vite serves a
    // JS-imported CSS file as a JS module that carries the CSS in a `const __vite__css = "..."`
    // literal (JSON-encoded); that module is valid JS, so vite-plugin-node-polyfills' inject plugin
    // passes it through intact. We deliberately AVOID the `?direct` variant: it serves raw CSS, which
    // the inject plugin then fails to parse-as-JS and truncates to the leading comment (whether via
    // transformRequest OR an HTTP fetch). We inline this at startup so the SSR first paint is styled.
    let css = '';
    for (const url of cssUrls) {
        try {
            const result = await server.transformRequest(url);
            const m = result?.code
                ? /const __vite__css = ("(?:[^"\\]|\\.)*")/.exec(result.code)
                : null;
            if (m) css += `${JSON.parse(m[1]) as string}\n`;
        } catch {
            // skip a stylesheet whose CSS can't be extracted; inline what we can
        }
    }
    return css;
}

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

    // Edge SSR in dev: render each `ssr = true` route against the LIVE (Vite-
    // transformed) dev shell into a template-with-holes, so the dev server can
    // splice the guest `render` values into it and serve real server-rendered
    // HTML (the prod-edge path), which then hydrates in place. Extracted once at
    // startup; a route's MARKUP change needs a dev restart to re-extract, but its
    // per-request VALUES are always live via `render`. Best-effort: on failure the
    // routes simply client-render as before.
    let ssrTemplates: DevSsrTemplate[] = [];
    try {
        const rawIndex = fs.readFileSync(path.join(cfg.toilDir, 'index.html'), 'utf8');
        let devShell = await server.transformIndexHtml('/', rawIndex);
        // In dev, Vite injects JS-imported CSS at RUNTIME (after the entry script runs), so a
        // server-rendered document would paint unstyled until then (a FOUC). INLINE the entry's CSS
        // into the SSR shell so the first paint is styled with no extra request (a `<link>` would
        // render-block the paint while Vite cold-serves the CSS, a visible blank beat). Prod bakes the
        // real `<link>` into the built shell; the client drops this <style> after hydration so Vite's
        // HMR-managed styles take over (see routing/mount.tsx).
        const devCss = await collectDevCss(server);
        if (devCss.trim().length > 0) {
            const tag = `<style data-toil-dev-ssr>${devCss}</style>`;
            devShell = devShell.includes('</head>')
                ? devShell.replace('</head>', `${tag}</head>`)
                : tag + devShell;
        }
        ssrTemplates = await extractDevSsrTemplates(cfg, devShell);
        if (ssrTemplates.length > 0) {
            process.stdout.write(
                pc.green('  ✓ ') +
                    pc.dim(`edge SSR: ${String(ssrTemplates.length)} route(s) server-rendered`) +
                    '\n',
            );
        }
    } catch (e) {
        process.stdout.write(
            pc.yellow('  ! ') + pc.dim(`SSR dev extraction skipped: ${String(e)}`) + '\n',
        );
    }

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
        ssrTemplates,
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

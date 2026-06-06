import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { build as viteBuild, createServer, type ViteDevServer } from 'vite';
import { startBackend, type RunningBackend } from 'toiljs/backend';

import { loadConfig } from './config.js';
import { generate } from './generate.js';
import { prerenderStaticParams } from './ssg.js';
import { createViteConfig } from './vite.js';

/**
 * Builds the toilscript server target (which also regenerates `shared/server.ts` via
 * `--rpcModule`) when the project has one, signalled by a `toilconfig.json` at the root. This
 * runs before the client build/dev so the generated `@data` + `Server` module the client
 * imports is always current; without it a stale or missing `shared/server.ts` breaks the
 * client build. A no-op for client-only projects. Runs the locally installed `toilscript`
 * (resolved + invoked via Node, so no `.bin` shim / PATH assumptions).
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

    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [binJs, '--target', 'release', '--rpcModule', 'shared/server.ts'],
            { cwd: root, stdio: 'inherit' },
        );
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0
                ? resolve()
                : reject(new Error(`toilscript server build failed (exit ${String(code)})`)),
        );
    });
}

export interface ToilCommandOptions {
    readonly root?: string;
    readonly port?: number;
    /** Bind host for `start`. Defaults to loopback (`127.0.0.1`); pass `0.0.0.0` to expose. */
    readonly host?: string;
}

/** Starts the Vite dev server (HMR + transforms) for the client app. Returns the running server. */
export async function dev(opts: ToilCommandOptions = {}): Promise<ViteDevServer> {
    const cfg = await loadConfig(opts);
    await buildServer(cfg.root);
    generate(cfg);
    const server = await createServer(await createViteConfig(cfg));
    await server.listen();
    server.printUrls();
    return server;
}

/** Produces an optimized production SPA bundle in the configured `outDir`. */
export async function build(opts: ToilCommandOptions = {}): Promise<void> {
    const cfg = await loadConfig(opts);
    await buildServer(cfg.root);
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

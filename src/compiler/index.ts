import fs from 'node:fs';
import path from 'node:path';

import { build as viteBuild, createServer, type ViteDevServer } from 'vite';
import { startBackend, type RunningBackend } from 'toiljs/backend';

import { loadConfig } from './config.js';
import { generate } from './generate.js';
import { prerenderStaticParams } from './ssg.js';
import { createViteConfig } from './vite.js';

export interface ToilCommandOptions {
    readonly root?: string;
    readonly port?: number;
}

/** Starts the Vite dev server (HMR + transforms) for the client app. Returns the running server. */
export async function dev(opts: ToilCommandOptions = {}): Promise<ViteDevServer> {
    const cfg = await loadConfig(opts);
    generate(cfg);
    const server = await createServer(await createViteConfig(cfg));
    await server.listen();
    server.printUrls();
    return server;
}

/** Produces an optimized production SPA bundle in the configured `outDir`. */
export async function build(opts: ToilCommandOptions = {}): Promise<void> {
    const cfg = await loadConfig(opts);
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
    return startBackend({ root: outDir, port: cfg.port });
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

import { build as viteBuild, createServer, type ViteDevServer } from 'vite';

import { loadConfig } from './config.js';
import { generate } from './generate.js';
import { createViteConfig } from './vite.js';

export interface ToilCommandOptions {
    readonly root?: string;
    readonly port?: number;
}

/** Starts the Vite dev server (HMR) for the client app. Returns the running server. */
export async function dev(opts: ToilCommandOptions = {}): Promise<ViteDevServer> {
    const cfg = await loadConfig(opts);
    generate(cfg);
    const server = await createServer(createViteConfig(cfg));
    await server.listen();
    server.printUrls();
    return server;
}

/** Produces an optimized production SPA bundle in the configured `outDir`. */
export async function build(opts: ToilCommandOptions = {}): Promise<void> {
    const cfg = await loadConfig(opts);
    generate(cfg);
    await viteBuild(createViteConfig(cfg));
}

export { defineConfig } from './config.js';
export type { ToilConfig } from './config.js';

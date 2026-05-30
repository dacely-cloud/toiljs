import fs from 'node:fs';
import path from 'node:path';

import { build as viteBuild, createServer, mergeConfig } from 'vite';
import { startBackend, startProxy, type RunningBackend, type RunningServer } from 'toiljs/backend';

import { loadConfig } from './config.js';
import { generate } from './generate.js';
import { createViteConfig } from './vite.js';

export interface ToilCommandOptions {
    readonly root?: string;
    readonly port?: number;
}

/**
 * Starts the dev server: Vite runs on an internal loopback port (doing TS/JSX transforms + HMR)
 * while the high-performance hyper-express/uWS backend proxies all HTTP on the public port. HMR
 * connects straight to Vite via its `clientPort`, so it works without proxying the WebSocket.
 * Returns a handle whose `close()` stops both servers.
 */
export async function dev(opts: ToilCommandOptions = {}): Promise<RunningServer> {
    const cfg = await loadConfig(opts);
    generate(cfg);

    const publicPort = cfg.port;
    const vitePort = publicPort + 1;

    const viteConfig = mergeConfig(createViteConfig(cfg), {
        server: {
            host: '127.0.0.1',
            port: vitePort,
            strictPort: true,
            allowedHosts: true,
            hmr: { clientPort: vitePort },
        },
    });
    const viteServer = await createServer(viteConfig);
    await viteServer.listen();

    const proxy = await startProxy({ target: `http://127.0.0.1:${vitePort}`, port: publicPort });

    return {
        port: proxy.port,
        host: proxy.host,
        close: async (): Promise<void> => {
            await proxy.close();
            await viteServer.close();
        },
    };
}

/** Produces an optimized production SPA bundle in the configured `outDir`. */
export async function build(opts: ToilCommandOptions = {}): Promise<void> {
    const cfg = await loadConfig(opts);
    generate(cfg);
    await viteBuild(createViteConfig(cfg));
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

export { defineConfig } from './config.js';
export type { ToilConfig } from './config.js';
export type { RunningBackend, RunningServer, BackendOptions } from 'toiljs/backend';

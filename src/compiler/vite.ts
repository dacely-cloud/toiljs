import path from 'node:path';

import react from '@vitejs/plugin-react';
import { mergeConfig, type InlineConfig } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { toilPlugin } from './plugin.js';

/**
 * Builds the framework-owned Vite config. Vite's `root` is the generated `.toil` dir so its
 * `index.html` emits at the output root (assets resolve correctly); `fs.allow` opens the
 * project (for `client/`) and the framework runtime. React plugin + toil route plugin are
 * wired in, `toiljs/client` is aliased to the runtime, and user `vite` overrides deep-merge on top.
 */
export function createViteConfig(cfg: ResolvedToilConfig): InlineConfig {
    // .../build/client/index.js -> framework package root (covers build/ + node_modules in dev)
    const frameworkRoot = path.resolve(path.dirname(cfg.runtimePath), '..', '..');

    const base: InlineConfig = {
        root: cfg.toilDir,
        base: cfg.base,
        configFile: false,
        plugins: [react(), toilPlugin(cfg)],
        resolve: {
            alias: {
                'toiljs/client': cfg.runtimePath,
            },
        },
        server: {
            port: cfg.port,
            fs: { allow: [cfg.root, frameworkRoot] },
        },
        build: {
            outDir: path.resolve(cfg.root, cfg.outDir),
            emptyOutDir: true,
        },
    };
    return mergeConfig(base, cfg.vite);
}

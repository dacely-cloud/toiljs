import path from 'node:path';

import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { mergeConfig, type InlineConfig } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { toilPlugin } from './plugin.js';

/** Image extensions routed to `images/` in the build output. */
const IMAGE_EXT = /^(png|jpe?g|svg|gif|tiff|bmp|ico|webp|avif)$/i;
/** Font extensions routed to `fonts/`. */
const FONT_EXT = /^(woff|woff2|eot|ttf|otf)$/i;

/** Routes a built asset to a typed sub-folder (`images/`, `fonts/`, `css/`, else `assets/`). */
function assetFileName(name: string): string {
    const ext = name.split('.').pop() ?? '';
    if (IMAGE_EXT.test(ext)) return 'images/[name][extname]';
    if (FONT_EXT.test(ext)) return 'fonts/[name][extname]';
    if (/^css$/i.test(ext)) return 'css/[name][extname]';
    return 'assets/[name][extname]';
}

/** Splits React's runtime into its own long-lived chunk for better caching. */
function manualChunks(id: string): string | undefined {
    if (!id.includes('node_modules')) return undefined;
    if (
        id.includes('node_modules/react-dom') ||
        id.includes('node_modules/react/') ||
        id.includes('node_modules/scheduler')
    ) {
        return 'react';
    }
    return undefined;
}

/**
 * Builds the framework-owned Vite config. Vite's `root` is the generated `.toil` dir so its
 * `index.html` emits at the output root (assets resolve correctly); `fs.allow` opens the
 * project (for `client/`) and the framework runtime. The opinionated default — Node polyfills
 * (Buffer/global/process), React plugin, toil route plugin, typed asset folders, React chunk
 * splitting and tuned build options — is applied here; `toiljs/client` is aliased to the
 * runtime, and the user's `client.vite` overrides deep-merge on top.
 */
export function createViteConfig(cfg: ResolvedToilConfig): InlineConfig {
    // .../build/client/index.js -> framework package root (covers build/ + node_modules in dev)
    const frameworkRoot = path.resolve(path.dirname(cfg.runtimePath), '..', '..');

    const base: InlineConfig = {
        root: cfg.toilDir,
        base: cfg.base,
        configFile: false,
        plugins: [
            nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
            react(),
            toilPlugin(cfg),
        ],
        resolve: {
            alias: {
                'toiljs/client': cfg.runtimePath,
            },
            dedupe: ['react', 'react-dom'],
        },
        server: {
            port: cfg.port,
            fs: { allow: [cfg.root, frameworkRoot] },
        },
        build: {
            outDir: path.resolve(cfg.root, cfg.outDir),
            emptyOutDir: true,
            target: 'es2020',
            modulePreload: false,
            cssCodeSplit: false,
            assetsInlineLimit: 10000,
            chunkSizeWarningLimit: 3000,
            commonjsOptions: {
                strictRequires: true,
                transformMixedEsModules: true,
            },
            rollupOptions: {
                output: {
                    chunkFileNames: 'assets/[name]-[hash].js',
                    assetFileNames: (assetInfo) => assetFileName(assetInfo.names[0] ?? ''),
                    manualChunks,
                },
            },
        },
    };
    return mergeConfig(base, cfg.vite);
}

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import react from '@vitejs/plugin-react';
import { imagetools } from 'vite-imagetools';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { mergeConfig, type InlineConfig, type PluginOption } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { imageReportPlugin } from './image-report.js';
import { toilPlugin } from './plugin.js';
import { prerenderPlugin } from './prerender.js';

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

/**
 * Loads the Tailwind v4 Vite plugin if the project has `@tailwindcss/vite` installed (added by
 * `toiljs create`/`configure` when Tailwind is enabled). Resolved from the project root so it picks
 * up the project's copy; returns `undefined` when Tailwind is off, so the plugin simply isn't added.
 */
async function tailwindPlugin(root: string): Promise<PluginOption | undefined> {
    let resolved: string;
    try {
        resolved = createRequire(path.join(root, 'package.json')).resolve('@tailwindcss/vite');
    } catch {
        return undefined;
    }
    const mod = (await import(pathToFileURL(resolved).href)) as { default?: () => PluginOption };
    return mod.default?.();
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
 * `index.html` (built from the project's `public/index.html` template) emits at the output root
 * with assets resolving correctly; static `public/` assets are mirrored to `.toil/public` and
 * picked up via Vite's default publicDir. `fs.allow` opens the project (for `client/`) and the
 * framework runtime. The opinionated default, Node polyfills
 * (Buffer/global/process), React plugin, toil route plugin, typed asset folders, React chunk
 * splitting and tuned build options, is applied here; `toiljs/client` is aliased to the
 * runtime, and the user's `client.vite` overrides deep-merge on top.
 */
export async function createViteConfig(cfg: ResolvedToilConfig): Promise<InlineConfig> {
    const frameworkRoot = path.resolve(path.dirname(cfg.runtimePath), '..', '..');
    const tailwind = await tailwindPlugin(cfg.root);

    const base: InlineConfig = {
        root: cfg.toilDir,
        base: cfg.base,
        configFile: false,
        plugins: [
            tailwind,
            // Build-time image resize/optimization. Every *imported* raster image is compressed to
            // webp by default (so a plain `<img src={imported}>` is optimized too, not just
            // `Toil.Image`); add `?w=400;800&format=…` to resize or pick a format. `public/` assets
            // referenced by string path are served as-is. Disabled by `client.images: false`.
            cfg.images
                ? imagetools({
                      defaultDirectives: () => new URLSearchParams({ format: 'webp', quality: '80' }),
                  })
                : undefined,
            cfg.images ? imageReportPlugin(cfg.root, cfg.toilDir) : undefined,
            // Static per-route SEO prerender (build only): bakes each route's metadata into its HTML.
            cfg.seo ? prerenderPlugin(cfg) : undefined,
            nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
            react(),
            toilPlugin(cfg),
        ],
        resolve: {
            alias: {
                'toiljs/client': cfg.runtimePath,
                'toiljs/routes': path.join(cfg.toilDir, 'routes.ts'),
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

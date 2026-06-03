import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { type InlineConfig } from 'vite';

import { type SeoConfig } from './seo.js';

export type { SeoConfig } from './seo.js';

/** Built-in AI providers the dev toolbar can proxy to. */
export enum AiProvider {
    Anthropic = 'anthropic',
    OpenAI = 'openai',
}

/** Dev toolbar AI integration (dev only; the key stays server-side). */
export interface DevtoolsAiConfig {
    /** Built-in provider. With `endpoint` set, that takes precedence. */
    readonly provider?: AiProvider;
    /** Model id (e.g. `claude-sonnet-4-6`, `gpt-4o`). */
    readonly model?: string;
    /** Name of the env var holding the API key (read by the dev server, never sent to the client). */
    readonly apiKeyEnv?: string;
    /** Custom POST endpoint (`{ prompt }` in, `{ text }` out); overrides `provider`. */
    readonly endpoint?: string;
}

/** Dev toolbar configuration. */
export interface DevtoolsConfig {
    readonly ai?: DevtoolsAiConfig;
}

/**
 * Client-side (TSX/React/Vite) configuration. All fields optional; sensible defaults applied.
 */
export interface ClientConfig {
    /** Client source directory, relative to root. Default `client`. */
    readonly srcDir?: string;
    /** Routes directory, relative to `srcDir`. Default `routes`. */
    readonly routesDir?: string;
    /**
     * Static assets directory, relative to root. Default `<srcDir>/public` (e.g. `client/public`).
     * Holds the `index.html` template (owned and edited by you) plus any files served as-is at the
     * base path (favicons, images, and the like).
     */
    readonly publicDir?: string;
    /** Production output directory, relative to root. Default `build/client`. */
    readonly outDir?: string;
    /** Public base path. Default `/`. */
    readonly base?: string;
    /** Dev server port. Default `3000`. */
    readonly port?: number;
    /**
     * Optimize imported images at build time (resize/convert via `vite-imagetools` + sharp): an
     * import like `logo.png?w=400;800&format=webp&as=srcset` emits resized, compressed variants.
     * Default `true`. Set `false` to disable the pipeline (images are then served as-is).
     */
    readonly images?: boolean;
    /**
     * Preload bundled fonts at build time: injects `<link rel="preload" as="font">` for each
     * `@font-face` font so it loads in parallel with the CSS (faster text paint). Default `true`.
     */
    readonly fonts?: boolean;
    /**
     * Animate cross-page navigations with the browser View Transitions API (a crossfade by default;
     * add `view-transition-name` in CSS for shared-element transitions). Respects
     * `prefers-reduced-motion`. Default `false`.
     */
    readonly viewTransitions?: boolean;
    /**
     * Wrap client navigations in a React transition, keeping the current page visible while the next
     * route's loader runs instead of showing its `loading.tsx` right away. Default `false` (a
     * navigation commits eagerly, so the loading state appears immediately).
     */
    readonly transitions?: boolean;
    /**
     * The dev toolbar (a floating panel in `toiljs dev` with route/build info, errors, and live
     * controls). `true` (default) / `false` to disable, or an object to configure its AI integration.
     * Never included in production builds. The AI key is read server-side from `apiKeyEnv` and never
     * reaches the browser; the toolbar always offers Claude/ChatGPT hand-off links regardless.
     */
    readonly devtools?: boolean | DevtoolsConfig;
    /**
     * Build-time SEO: bakes site-level metadata into the HTML `<head>` (so JS-less crawlers and AI
     * bots see real tags) and generates `robots.txt`, `sitemap.xml`, and `llms.txt`. Omit to skip.
     */
    readonly seo?: SeoConfig;
    /**
     * Raw Vite escape hatch, deep-merged over the framework's opinionated config.
     * This is NOT the client config itself, toil owns the Vite setup; use this only
     * to override specific Vite options.
     */
    readonly vite?: InlineConfig;
}

/**
 * Server-side (toilscript → WASM) configuration. Reserved: the compiler does not yet
 * build the server target via `toil build`; today it is compiled by `toilscript` directly.
 */
export interface ServerConfig {
    /** Server source directory, relative to root. Default `server`. */
    readonly srcDir?: string;
    /** Server build output directory, relative to root. Default `build/server`. */
    readonly outDir?: string;
}

/**
 * The `toil.config` schema. All fields optional; sensible defaults applied.
 * Client and server are configured in separate sections.
 */
export interface ToilConfig {
    /** Project root. Defaults to the current working directory. */
    readonly root?: string;
    /** Client (TSX/React/Vite) configuration. */
    readonly client?: ClientConfig;
    /** Server (toilscript/WASM) configuration. */
    readonly server?: ServerConfig;
}

/** Fully-resolved config with absolute paths, used internally by the compiler. */
export interface ResolvedToilConfig {
    readonly root: string;
    readonly srcDir: string;
    readonly clientAbsDir: string;
    readonly routesAbsDir: string;
    /** Absolute path to the static-assets dir (holds the `index.html` template). */
    readonly publicDir: string;
    readonly toilDir: string;
    readonly outDir: string;
    readonly base: string;
    readonly port: number;
    /** Whether build-time image optimization (`vite-imagetools`) is enabled. */
    readonly images: boolean;
    /** Whether build-time font preloading is enabled. */
    readonly fonts: boolean;
    /** Whether animated View Transitions are enabled for navigation. */
    readonly viewTransitions: boolean;
    /** Whether navigations are wrapped in a React transition (keep current page while loading). */
    readonly transitions: boolean;
    /** Whether the dev toolbar is enabled (dev only). */
    readonly devtools: boolean;
    /** Dev toolbar AI config (dev only), or `null` when not configured. */
    readonly devtoolsAi: DevtoolsAiConfig | null;
    /** Build-time SEO config, or `null` when not configured. */
    readonly seo: SeoConfig | null;
    /** Absolute path to the framework client runtime (`toiljs/client`). */
    readonly runtimePath: string;
    readonly vite: InlineConfig;
}

/** Identity helper for typed config files: `export default defineConfig({ ... })`. */
export function defineConfig(config: ToilConfig): ToilConfig {
    return config;
}

const CONFIG_NAMES = [
    'toil.config.ts',
    'toil.config.mts',
    'toil.config.js',
    'toil.config.mjs',
    'toiljs.config.ts',
    'toiljs.config.mts',
    'toiljs.config.js',
    'toiljs.config.mjs',
];

/** Path to the built client runtime (`build/client/index.js`), sibling to `build/compiler`. */
function resolveRuntimePath(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/index.js');
}

/** Finds and loads `toil.config.*` or `toiljs.config.*` from `root`, then resolves defaults. */
export async function loadConfig(
    opts: { root?: string; port?: number } = {},
): Promise<ResolvedToilConfig> {
    const root = path.resolve(opts.root ?? process.cwd());

    let user: ToilConfig = {};
    for (const name of CONFIG_NAMES) {
        const candidate = path.join(root, name);
        if (fs.existsSync(candidate)) {
            const loaded = (await import(pathToFileURL(candidate).href)) as {
                default?: ToilConfig;
            };
            if (loaded.default) user = loaded.default;
            break;
        }
    }

    const client = user.client ?? {};
    const srcDir = client.srcDir ?? 'client';
    const routesDir = client.routesDir ?? 'routes';
    const clientAbsDir = path.join(root, srcDir);

    return {
        root,
        srcDir,
        clientAbsDir,
        routesAbsDir: path.join(clientAbsDir, routesDir),
        publicDir: client.publicDir
            ? path.resolve(root, client.publicDir)
            : path.join(clientAbsDir, 'public'),
        toilDir: path.join(root, '.toil'),
        outDir: client.outDir ?? 'build/client',
        base: client.base ?? '/',
        port: opts.port ?? client.port ?? 3000,
        images: client.images ?? true,
        fonts: client.fonts ?? true,
        viewTransitions: client.viewTransitions ?? false,
        transitions: client.transitions ?? false,
        devtools: client.devtools !== false,
        devtoolsAi:
            typeof client.devtools === 'object' && client.devtools.ai ? client.devtools.ai : null,
        seo: client.seo ?? null,
        runtimePath: resolveRuntimePath(),
        vite: client.vite ?? {},
    };
}

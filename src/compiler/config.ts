import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { type InlineConfig } from 'vite';
import { type EmailBackendConfig } from 'toiljs/shared';

import { type SeoConfig } from './seo.js';

export type { SeoConfig } from './seo.js';
export type { EmailBackendConfig, SmtpBackendConfig } from 'toiljs/shared';

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
 * Dev node mode: which layer the single dev process emulates. `hot` runs only the
 * request path (today's behavior); `regional`/`continental` would run streams off
 * `release-hot.wasm` (Phase 4); `daemon` runs `release-cold.wasm`; `all` runs every
 * surface in one process (the default for a full local run). DEV / self-host knob;
 * the production edge reads the authoritative role from per-host TCF + the plan.
 */
export type DevNodeMode = 'hot' | 'regional' | 'continental' | 'daemon' | 'all';

/** Daemon (L4) config mirror (dev / self-host). All optional. */
export interface DaemonConfig {
    /** Region the daemon is pinned to (informational in dev; the dev process is leader). */
    readonly region?: string;
    /** Warm standby region (informational in dev). */
    readonly standbyRegion?: string;
    /** Default `@scheduled` interval (ms) when a task declares none. Default 60000. */
    readonly defaultIntervalMs?: number;
    /** Per-tick wall-clock budget (ms) before the dev scheduler logs an overrun. Default 30000. */
    readonly tickBudgetMs?: number;
    /** Per-tick gas cap (dev stub; charged-then-ignored). Mirrors `plan.gas_scheduled`. */
    readonly gasTick?: number;
    /** Max number of `@scheduled` tasks (mirrors `max_scheduled_tasks`). Default 64. */
    readonly maxTasks?: number;
}

/**
 * Server-side (toilscript → WASM) configuration.
 */
export interface ServerConfig {
    /** Server source directory, relative to root. Default `server`. */
    readonly srcDir?: string;
    /** Server build output directory, relative to root. Default `build/server`. */
    readonly outDir?: string;
    /**
     * Email backend config (the dev server and the future Node self-host). The
     * non-secret pieces — provider, `from`, send caps, SMTP host/port/user. The
     * API key / SMTP password is a SECRET and lives ONLY in `.env.secrets`
     * (`TOIL_EMAIL_API_KEY`); any `TOIL_EMAIL_*` env var overrides the matching
     * field here. The production edge ignores this (it reads `TOIL_EMAIL_*` from
     * the per-tenant env store); this drives `toiljs dev` / self-host.
     */
    readonly email?: EmailBackendConfig;
    /** Which layer the dev process emulates. Default `all`. */
    readonly nodeMode?: DevNodeMode;
    /**
     * Built-in auth. `true` opts into the framework's post-quantum login: the
     * build appends a shipped `@rest('auth')` controller + its `@user` shape to
     * the toilscript entry set, so the app gets the full `/auth/register|login`
     * API + sessions (`/auth/me`, `/auth/logout`) with no hand-written boilerplate.
     * Default `false`. (The escape hatch `import 'toiljs/server/auth'` in
     * `server/main.ts` does the same without this flag.) An app that opts in must
     * NOT declare its own `@user` — the built-in owns the single per-program one.
     */
    readonly auth?: boolean;
    /** Daemon (L4) config mirror (dev / self-host). */
    readonly daemon?: DaemonConfig;
    /**
     * Self-host HTTP worker count for `toiljs start`. Default `auto`
     * (`os.availableParallelism()`). Set `1` to disable the worker pool.
     */
    readonly threads?: number | 'auto';
}

/** Fully-resolved {@link DaemonConfig}; every field non-optional, defaults applied. */
export interface ResolvedDaemonConfig {
    readonly region: string | null;
    readonly standbyRegion: string | null;
    readonly defaultIntervalMs: number;
    readonly tickBudgetMs: number;
    readonly gasTick: number;
    readonly maxTasks: number;
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
    /** The `server.email` backend config (dev / self-host), or `null` when unset. */
    readonly email: EmailBackendConfig | null;
    /** Which layer the dev process emulates (dev / self-host). Default `all`. */
    readonly nodeMode: DevNodeMode;
    /** Whether the built-in `/auth/*` PQ-login controller is compiled + mounted. */
    readonly auth: boolean;
    /** Daemon (L4) config mirror (dev / self-host), every field resolved. */
    readonly daemon: ResolvedDaemonConfig;
    /** Self-host HTTP worker count for `toiljs start`. */
    readonly threads: number | 'auto';
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
            client.devtools != null && typeof client.devtools === 'object'
                ? (client.devtools.ai ?? null)
                : null,
        seo: client.seo ?? null,
        email: user.server?.email ?? null,
        nodeMode: resolveNodeMode(user.server?.nodeMode),
        auth: user.server?.auth === true,
        daemon: resolveDaemonConfig(user.server?.daemon),
        threads: resolveThreads(user.server?.threads),
        runtimePath: resolveRuntimePath(),
        vite: client.vite ?? {},
    };
}

const DEV_NODE_MODES: readonly DevNodeMode[] = ['hot', 'regional', 'continental', 'daemon', 'all'];

/** A `nodeMode` outside the enum falls back to `all` with a warning (fail-soft:
 *  the authoritative role is the edge's TCF + plan, so dev never bricks on it). */
function resolveNodeMode(mode: DevNodeMode | undefined): DevNodeMode {
    if (mode === undefined) return 'all';
    if (DEV_NODE_MODES.includes(mode)) return mode;
    process.stdout.write(
        `  ! server.nodeMode '${mode}' is not a valid node mode; falling back to 'all'\n`,
    );
    return 'all';
}

/** Resolve the daemon config with defaults + light, fail-soft clamping (never
 *  throws; the authoritative caps are the edge's). */
function resolveDaemonConfig(d: DaemonConfig | undefined): ResolvedDaemonConfig {
    // The dev scheduler uses setInterval; a sub-second loop floods the console.
    let defaultIntervalMs = d?.defaultIntervalMs ?? 60000;
    if (defaultIntervalMs < 1000) {
        process.stdout.write(
            `  ! server.daemon.defaultIntervalMs ${String(defaultIntervalMs)} < 1000; clamping to 1000\n`,
        );
        defaultIntervalMs = 1000;
    }
    let maxTasks = d?.maxTasks ?? 64;
    if (maxTasks <= 0 || maxTasks > 1024) maxTasks = Math.min(1024, Math.max(1, maxTasks || 64));
    return {
        region: d?.region ?? null,
        standbyRegion: d?.standbyRegion ?? null,
        defaultIntervalMs,
        tickBudgetMs: d?.tickBudgetMs ?? 30000,
        gasTick: d?.gasTick ?? 0,
        maxTasks,
    };
}

function resolveThreads(threads: number | 'auto' | undefined): number | 'auto' {
    if (threads === undefined || threads === 'auto') return 'auto';
    if (!Number.isFinite(threads)) return 'auto';
    return Math.max(1, Math.min(128, Math.floor(threads)));
}

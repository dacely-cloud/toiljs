import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runnerImport, type InlineConfig } from 'vite';

/**
 * Client-side (TSX/React/Vite) configuration. All fields optional; sensible defaults applied.
 */
export interface ClientConfig {
    /** Client source directory, relative to root. Default `client`. */
    readonly srcDir?: string;
    /** Routes directory, relative to `srcDir`. Default `routes`. */
    readonly routesDir?: string;
    /** Production output directory, relative to root. Default `dist`. */
    readonly outDir?: string;
    /** Public base path. Default `/`. */
    readonly base?: string;
    /** Dev server port. Default `3000`. */
    readonly port?: number;
    /**
     * Raw Vite escape hatch, deep-merged over the framework's opinionated config.
     * This is NOT the client config itself — toil owns the Vite setup; use this only
     * to override specific Vite options.
     */
    readonly vite?: InlineConfig;
}

/**
 * Server-side (AssemblyScript → WASM) configuration. Reserved: the compiler does not yet
 * build the server target via `toil build`; today it is compiled by `toilscript` directly.
 */
export interface ServerConfig {
    /** Server source directory, relative to root. Default `server`. */
    readonly srcDir?: string;
    /** Server build output directory, relative to root. Default `build/server`. */
    readonly outDir?: string;
}

/**
 * The `toil.config` schema (Next.js-style). All fields optional; sensible defaults applied.
 * Client and server are configured in separate sections.
 */
export interface ToilConfig {
    /** Project root. Defaults to the current working directory. */
    readonly root?: string;
    /** Client (TSX/React/Vite) configuration. */
    readonly client?: ClientConfig;
    /** Server (AssemblyScript/WASM) configuration. */
    readonly server?: ServerConfig;
}

/** Fully-resolved config with absolute paths, used internally by the compiler. */
export interface ResolvedToilConfig {
    readonly root: string;
    readonly srcDir: string;
    readonly clientAbsDir: string;
    readonly routesAbsDir: string;
    readonly toilDir: string;
    readonly outDir: string;
    readonly base: string;
    readonly port: number;
    /** Absolute path to the framework client runtime (`toiljs/client`). */
    readonly runtimePath: string;
    readonly vite: InlineConfig;
}

/** Identity helper for typed config files: `export default defineConfig({ ... })`. */
export function defineConfig(config: ToilConfig): ToilConfig {
    return config;
}

const CONFIG_NAMES = ['toil.config.ts', 'toil.config.mts', 'toil.config.js', 'toil.config.mjs'];

/** Path to the built client runtime (`build/client/index.js`), sibling to `build/compiler`. */
function resolveRuntimePath(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/index.js');
}

/** Finds and loads `toil.config.*` from `root` (via Vite's bundling loader), then resolves defaults. */
export async function loadConfig(
    opts: { root?: string; port?: number } = {},
): Promise<ResolvedToilConfig> {
    const root = path.resolve(opts.root ?? process.cwd());

    let user: ToilConfig = {};
    for (const name of CONFIG_NAMES) {
        const candidate = path.join(root, name);
        if (fs.existsSync(candidate)) {
            // Vite's module runner bundles/transforms the (possibly .ts) config and returns it
            // typed as our `ToilConfig` — no cast needed.
            const { module } = await runnerImport<{ default?: ToilConfig }>(candidate);
            if (module.default) user = module.default;
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
        toilDir: path.join(root, '.toil'),
        outDir: client.outDir ?? 'dist',
        base: client.base ?? '/',
        port: opts.port ?? client.port ?? 3000,
        runtimePath: resolveRuntimePath(),
        vite: client.vite ?? {},
    };
}

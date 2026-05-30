import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFromFile } from 'vite';

/**
 * The `toil.config` schema (Next.js-style). All fields optional; sensible defaults applied.
 */
export interface ToilConfig {
    /** Project root. Defaults to the current working directory. */
    readonly root?: string;
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
    /** Extra Vite options, deep-merged over the framework's config. */
    readonly vite?: Record<string, unknown>;
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
    readonly vite: Record<string, unknown>;
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
export async function loadConfig(opts: { root?: string; port?: number } = {}): Promise<ResolvedToilConfig> {
    const root = path.resolve(opts.root ?? process.cwd());

    let user: ToilConfig = {};
    for (const name of CONFIG_NAMES) {
        const candidate = path.join(root, name);
        if (fs.existsSync(candidate)) {
            const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, candidate, root);
            user = (loaded?.config ?? {}) as ToilConfig;
            break;
        }
    }

    const srcDir = user.srcDir ?? 'client';
    const routesDir = user.routesDir ?? 'routes';
    const clientAbsDir = path.join(root, srcDir);

    return {
        root,
        srcDir,
        clientAbsDir,
        routesAbsDir: path.join(clientAbsDir, routesDir),
        toilDir: path.join(root, '.toil'),
        outDir: user.outDir ?? 'dist',
        base: user.base ?? '/',
        port: opts.port ?? user.port ?? 3000,
        runtimePath: resolveRuntimePath(),
        vite: user.vite ?? {},
    };
}

/**
 * toiljs compiler configuration schema — the `toil.config` format (Next.js-style).
 * Placeholder shape; extended as the compiler grows.
 */

export interface ToilConfig {
    /** Project root. Defaults to the current working directory. */
    readonly root?: string;
    /** Output directory for the compiled client bundle. */
    readonly outDir?: string;
    /** Extra Vite options merged into the framework's extended config. */
    readonly vite?: Record<string, unknown>;
}

export function defineConfig(config: ToilConfig): ToilConfig {
    return config;
}

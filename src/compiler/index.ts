import { build as viteBuild, createServer, type InlineConfig } from 'vite';

import { type ToilConfig } from './config.js';
import { createViteConfig } from './vite.js';

/**
 * toiljs compiler engine. Drives client compilation through the Vite JS API with the
 * framework's extended config, and (later) orchestrates the AssemblyScript backend build.
 * Placeholder implementations for now.
 */

function resolveRoot(config: ToilConfig): string {
    return config.root ?? process.cwd();
}

export async function compile(config: ToilConfig = {}): Promise<void> {
    const viteConfig: InlineConfig = createViteConfig(resolveRoot(config));
    await viteBuild(viteConfig);
}

export async function dev(config: ToilConfig = {}): Promise<void> {
    const server = await createServer(createViteConfig(resolveRoot(config)));
    await server.listen();
}

export { defineConfig } from './config.js';
export type { ToilConfig } from './config.js';
export { createViteConfig } from './vite.js';

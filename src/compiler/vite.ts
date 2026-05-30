import react from '@vitejs/plugin-react';
import { type InlineConfig } from 'vite';

/**
 * Builds the toiljs-extended Vite config. This is where the framework injects its
 * defaults (plugins, resolve aliases, optimizations) on top of the user's config —
 * analogous to how Next.js extends its bundler config.
 */
export function createViteConfig(root: string): InlineConfig {
    return {
        root,
        plugins: [react()],
    };
}

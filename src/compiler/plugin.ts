import { type Plugin } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { generate } from './generate.js';

/**
 * Vite plugin that keeps the generated route table in sync during dev: when a route file is
 * added or removed, it regenerates `.toil/routes.ts` and triggers a full reload. Editing a
 * route file's contents hot-reloads through `@vitejs/plugin-react` as usual.
 */
export function toilPlugin(cfg: ResolvedToilConfig): Plugin {
    return {
        name: 'toil',
        // Catch empty import specifiers in source and report the file — rolldown otherwise fails
        // resolution with a cryptic "The specifiers must be a non-empty string. Received ''".
        transform(code, id) {
            const file = id.split('?')[0];
            if (id.includes('\0') || file.includes('/node_modules/') || !/\.[mc]?[jt]sx?$/.test(file)) {
                return null;
            }
            const empty =
                /^[ \t]*import\s+(['"])\1\s*;?[ \t]*$/m.test(code) ||
                /^[ \t]*import\b[^'"\n]*\bfrom\s+(['"])\1/m.test(code) ||
                /^[ \t]*export\b[^'"\n]*\bfrom\s+(['"])\1/m.test(code) ||
                /\bimport\s*\(\s*(['"])\1\s*\)/.test(code);
            if (empty) {
                throw new Error(
                    `toil: empty import specifier (e.g. \`import '';\`) in ${file} — remove or complete the import.`,
                );
            }
            return null;
        },
        configureServer(server) {
            // Trailing slash so a sibling like `routes-extra/` doesn't match the `routes/` prefix.
            const routesPrefix = cfg.routesAbsDir.replace(/\\/g, '/').replace(/\/?$/, '/');
            const onChange = (file: string): void => {
                if (file.replace(/\\/g, '/').startsWith(routesPrefix)) {
                    generate(cfg);
                    server.ws.send({ type: 'full-reload' });
                }
            };
            server.watcher.add(cfg.routesAbsDir);
            server.watcher.on('add', onChange);
            server.watcher.on('unlink', onChange);
        },
    };
}

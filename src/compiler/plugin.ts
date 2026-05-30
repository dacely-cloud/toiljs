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
        configureServer(server) {
            const onChange = (file: string): void => {
                if (file.replace(/\\/g, '/').startsWith(cfg.routesAbsDir.replace(/\\/g, '/'))) {
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

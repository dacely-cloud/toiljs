import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Plugin } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { generate } from './generate.js';
import { scanRoutes } from './routes.js';

/** Reads a package's version resolved from `<fromDir>`, or 'unknown'. */
function depVersion(fromDir: string, name: string): string {
    try {
        const pkgPath = createRequire(path.join(fromDir, 'package.json')).resolve(`${name}/package.json`);
        const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
        return raw.version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

/** toiljs's own version (package.json two levels up from build/compiler). */
function frameworkVersion(): string {
    try {
        const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
        const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string };
        return raw.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/** Build/config snapshot served to the dev toolbar at `/__toil/devinfo`. */
function devInfo(cfg: ResolvedToilConfig, port: number): Record<string, unknown> {
    const routes: Record<string, string> = {};
    for (const r of scanRoutes(cfg.routesAbsDir)) {
        if (r.slot === undefined && !r.intercept) routes[r.pattern] = r.file;
    }
    return {
        toiljs: frameworkVersion(),
        vite: depVersion(cfg.root, 'vite'),
        react: depVersion(cfg.root, 'react'),
        port,
        enabled: cfg.devtools,
        flags: {
            images: cfg.images,
            fonts: cfg.fonts,
            viewTransitions: cfg.viewTransitions,
            transitions: cfg.transitions,
            seo: cfg.seo != null,
        },
        routes,
        ai: false,
    };
}

/** Opens `file` in the user's editor (best-effort): `$EDITOR file`, else `code -g file`. */
function openInEditor(file: string): void {
    try {
        const editor = process.env.EDITOR ?? process.env.VISUAL;
        const child = editor
            ? spawn(editor, [file], { stdio: 'ignore', detached: true })
            : spawn('code', ['-g', file], { stdio: 'ignore', detached: true });
        child.on('error', () => undefined);
        child.unref();
    } catch {
        /* ignore */
    }
}

/**
 * Vite plugin that keeps the generated route table in sync during dev: when a route file is
 * added or removed, it regenerates `.toil/routes.ts` and triggers a full reload. Editing a
 * route file's contents hot-reloads through `@vitejs/plugin-react` as usual.
 */
export function toilPlugin(cfg: ResolvedToilConfig): Plugin {
    return {
        name: 'toil',
        // Catch empty import specifiers in source and report the file, rolldown otherwise fails
        // resolution with a cryptic "The specifiers must be a non-empty string. Received ''".
        transform(code, id) {
            const file = id.split('?')[0];
            if (
                id.includes('\0') ||
                file.includes('/node_modules/') ||
                !/\.[mc]?[jt]sx?$/.test(file)
            ) {
                return null;
            }
            const empty =
                /^[ \t]*import\s+(['"])\1\s*;?[ \t]*$/m.test(code) ||
                /^[ \t]*import\b[^'"\n]*\bfrom\s+(['"])\1/m.test(code) ||
                /^[ \t]*export\b[^'"\n]*\bfrom\s+(['"])\1/m.test(code) ||
                /\bimport\s*\(\s*(['"])\1\s*\)/.test(code);
            if (empty) {
                throw new Error(
                    `toil: empty import specifier (e.g. \`import '';\`) in ${file}, remove or complete the import.`,
                );
            }
            return null;
        },
        configureServer(server) {
            // Dev toolbar endpoints (dev only). `/__toil/devinfo` -> build/config snapshot;
            // `/__toil/open?file=` -> open the file in the editor.
            server.middlewares.use('/__toil/devinfo', (_req, res) => {
                const port = server.config.server.port ?? cfg.port;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(devInfo(cfg, port)));
            });
            server.middlewares.use('/__toil/open', (req, res) => {
                try {
                    const url = new URL(req.url ?? '', 'http://localhost');
                    const file = url.searchParams.get('file');
                    const abs = file ? path.resolve(file) : '';
                    // Only files inside the project root, never an arbitrary path.
                    if (abs && abs.startsWith(cfg.root) && fs.existsSync(abs)) openInEditor(abs);
                    res.statusCode = 204;
                    res.end();
                } catch {
                    res.statusCode = 400;
                    res.end();
                }
            });

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

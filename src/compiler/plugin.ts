import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Plugin } from 'vite';

import { AiProvider, type DevtoolsAiConfig, type ResolvedToilConfig } from './config.js';
import { generate } from './generate.js';
import { scanRoutes } from './routes.js';

/** Calls the configured AI provider (server-side, so the key never reaches the browser). */
async function aiComplete(ai: DevtoolsAiConfig, prompt: string): Promise<string> {
    const key = ai.apiKeyEnv ? process.env[ai.apiKeyEnv] : undefined;
    if (ai.endpoint) {
        const r = await fetch(ai.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });
        const j = (await r.json()) as { text?: string };
        return j.text ?? '';
    }
    if (ai.provider === AiProvider.OpenAI) {
        if (!key) throw new Error(`missing API key (set env ${ai.apiKeyEnv ?? 'OPENAI_API_KEY'})`);
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({
                model: ai.model ?? 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
            }),
        });
        const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        return j.choices?.[0]?.message?.content ?? '';
    }
    // default: anthropic
    if (!key) throw new Error(`missing API key (set env ${ai.apiKeyEnv ?? 'ANTHROPIC_API_KEY'})`);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: ai.model ?? 'claude-sonnet-4-6',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
        }),
    });
    const j = (await r.json()) as { content?: { text?: string }[] };
    return (j.content ?? []).map((c) => c.text ?? '').join('');
}

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
        ai: cfg.devtoolsAi !== null,
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
            // `/__toil/ai` -> server-side AI proxy. The key is read from the env here and never
            // reaches the browser; 404 when AI isn't configured (the toolbar then only hands off).
            server.middlewares.use('/__toil/ai', (req, res) => {
                if (req.method !== 'POST') {
                    res.statusCode = 405;
                    res.end();
                    return;
                }
                const ai = cfg.devtoolsAi;
                if (!ai) {
                    res.statusCode = 404;
                    res.end();
                    return;
                }
                let body = '';
                req.on('data', (chunk) => (body += String(chunk)));
                req.on('end', () => {
                    void (async () => {
                        try {
                            const { prompt } = JSON.parse(body || '{}') as { prompt?: string };
                            const text = await aiComplete(ai, prompt ?? '');
                            res.setHeader('content-type', 'application/json');
                            res.end(JSON.stringify({ text }));
                        } catch (e) {
                            res.statusCode = 500;
                            res.setHeader('content-type', 'application/json');
                            res.end(
                                JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
                            );
                        }
                    })();
                });
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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Plugin, version as viteVersion } from 'vite';

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
        // vite is a dependency of the framework, not the app, so resolving it from the app root
        // fails; read the running vite's own exported version instead.
        vite: viteVersion,
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

/**
 * Resolves a request's `file` param to an absolute path that is genuinely inside the project root,
 * or null. Guards against `..` traversal, sibling-prefix escapes (`<root>-evil/secret` passes a bare
 * `startsWith(root)`), and symlinks inside the project that point outside it (realpath re-check).
 */
function safeProjectPath(cfg: ResolvedToilConfig, file: string | null): string | null {
    if (!file) return null;
    const root = cfg.root;
    const inside = (p: string): boolean => p === root || p.startsWith(root + path.sep);
    const abs = path.resolve(file);
    if (!inside(abs) || !fs.existsSync(abs)) return null;
    try {
        const real = fs.realpathSync(abs);
        return inside(real) ? real : null;
    } catch {
        return null;
    }
}

/**
 * True for requests that must NOT reach the dev endpoints (they open files, read source, and spend
 * AI credits). Uses an allowlist on the browser-set `Sec-Fetch-Site`: only `same-origin` (the
 * toolbar), `none` (user-initiated, e.g. the address bar), or an absent header (non-browser tooling
 * like curl) are allowed. Everything else, `cross-site`, `same-site`, or any unexpected value, is
 * rejected. This blocks CSRF (a malicious site's fetch/img) without breaking local dev tooling.
 */
function isCrossSiteRequest(headers: IncomingMessage['headers']): boolean {
    const site = headers['sec-fetch-site'];
    return site !== undefined && site !== 'same-origin' && site !== 'none';
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
            server.middlewares.use('/__toil/devinfo', (req, res) => {
                if (isCrossSiteRequest(req.headers)) {
                    res.statusCode = 403;
                    res.end();
                    return;
                }
                const port = server.config.server.port ?? cfg.port;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify(devInfo(cfg, port)));
            });
            // `/__toil/ai` -> server-side AI proxy. The key is read from the env here and never
            // reaches the browser; 404 when AI isn't configured (the toolbar then only hands off).
            server.middlewares.use('/__toil/ai', (req, res) => {
                if (isCrossSiteRequest(req.headers)) {
                    res.statusCode = 403;
                    res.end();
                    return;
                }
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
                let aborted = false;
                req.on('data', (chunk) => {
                    if (aborted) return;
                    body += String(chunk);
                    if (body.length > 100_000) {
                        // Cap the request body so a runaway/malicious POST can't grow it unbounded.
                        aborted = true;
                        res.statusCode = 413;
                        res.end();
                        req.destroy();
                    }
                });
                req.on('end', () => {
                    if (aborted) return;
                    void (async () => {
                        try {
                            const parsed = JSON.parse(body || '{}') as { prompt?: string };
                            // Cap the prompt actually forwarded upstream (independent of the raw-body cap).
                            const prompt =
                                typeof parsed.prompt === 'string' ? parsed.prompt.slice(0, 16000) : '';
                            const text = await aiComplete(ai, prompt);
                            res.setHeader('content-type', 'application/json');
                            res.end(JSON.stringify({ text }));
                        } catch (e) {
                            // Log the detail to the dev's terminal; return a generic message to the
                            // client so upstream/provider error text is never reflected over HTTP.
                            process.stderr.write(
                                `toil: /__toil/ai failed: ${e instanceof Error ? e.message : String(e)}\n`,
                            );
                            res.statusCode = 500;
                            res.setHeader('content-type', 'application/json');
                            res.end(JSON.stringify({ error: 'AI request failed (see dev server logs).' }));
                        }
                    })();
                });
            });
            server.middlewares.use('/__toil/open', (req, res) => {
                try {
                    if (isCrossSiteRequest(req.headers)) {
                        res.statusCode = 403;
                        res.end();
                        return;
                    }
                    const url = new URL(req.url ?? '', 'http://localhost');
                    const abs = safeProjectPath(cfg, url.searchParams.get('file'));
                    if (abs) openInEditor(abs);
                    res.statusCode = 204;
                    res.end();
                } catch {
                    res.statusCode = 400;
                    res.end();
                }
            });
            // `/__toil/source?file=` -> the file's text, so the AI tab can include the page's code in
            // its prompt. Same root-confinement (`safeProjectPath`) as `/__toil/open`; capped so a
            // stray huge file can't bloat the response.
            server.middlewares.use('/__toil/source', (req, res) => {
                try {
                    if (isCrossSiteRequest(req.headers)) {
                        res.statusCode = 403;
                        res.end();
                        return;
                    }
                    const url = new URL(req.url ?? '', 'http://localhost');
                    const abs = safeProjectPath(cfg, url.searchParams.get('file'));
                    if (!abs) {
                        res.statusCode = 404;
                        res.end();
                        return;
                    }
                    const text = fs.readFileSync(abs, 'utf8').slice(0, 20000);
                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                    res.end(text);
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

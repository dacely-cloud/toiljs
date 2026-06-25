/**
 * Built-app self-host server: static assets + ToilScript wasm dispatch + edge
 * SSR template assembly. This is the production counterpart to the dev front
 * server, except the fallback is the built client directory instead of Vite.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
    type MiddlewareNext,
    type Request,
    type Response,
    Server,
    type Websocket,
} from '@dacely/hyper-express';
import pc from 'picocolors';

import type { EmailBackendConfig } from 'toiljs/shared';

import { configureDbPersistence } from './db/index.js';
import { initEmailService } from './email/index.js';
import { applyCacheRule, lookupCache } from './http/cache.js';
import { type EnvelopeRequest, METHOD_CODES } from './http/envelope.js';
import { WasmServerModule } from './runtime/module.js';
import {
    assembleSsr,
    buildSsrRoutes,
    type DevSsrTemplate,
    pathnameOf,
    type SsrResult,
} from './ssr.js';

const DEFAULT_MAX_BODY_LENGTH = 1024 * 1024 * 8;
const MAX_BODY_BUFFER = 1024 * 32;
const HTTP_IDLE_TIMEOUT = 60;
const HTTP_RESPONSE_TIMEOUT = 120;

const WS_MAX_PAYLOAD_LENGTH = 1024 * 1024;
const WS_IDLE_TIMEOUT = 120;
const WS_MAX_BACKPRESSURE = 1024 * 1024 * 2;

const CORS_METHODS = 'GET, POST, OPTIONS, PUT, PATCH, DELETE';
const CORS_HEADERS = 'X-Requested-With, content-type';

const MIME: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
};

export interface BuiltServerOptions {
    /** Project root; wasm sendfile paths and local data resolve here. */
    readonly root: string;
    /** Built client directory, usually `<root>/build/client`. */
    readonly staticRoot: string;
    /** Built server wasm, usually `<root>/build/server/release.wasm`. */
    readonly wasmFile?: string;
    /** Listening port. Default `3000`. */
    readonly port?: number;
    /** Bind host. Default `127.0.0.1`. */
    readonly host?: string;
    /** Extra origins allowed to open the WebSocket channel. */
    readonly allowedOrigins?: readonly string[];
    /** WebSocket channel path. Default `/_toil`. */
    readonly wsPath?: string;
    /** Send permissive CORS headers + handle preflight. Default `true`. */
    readonly cors?: boolean;
    /** Max request body bytes. Default 8 MB. */
    readonly maxBodyLength?: number;
    /** Optional self-host email config, secrets still come from env/.env.secrets. */
    readonly email?: EmailBackendConfig;
}

export interface RunningBuiltServer {
    readonly port: number;
    readonly host: string;
    readonly wsPath: string;
    broadcast(message: string): void;
    clientCount(): number;
    close(): Promise<void>;
}

interface TemplateIndexEntry {
    route: string;
    name: string;
    hash?: string;
}

function isWsOriginAllowed(
    origin: string | undefined,
    hostHeader: string | undefined,
    allowed: readonly string[] | undefined,
): boolean {
    if (!origin) return true;
    if (allowed?.includes(origin)) return true;
    try {
        return new URL(origin).host === hostHeader;
    } catch {
        return false;
    }
}

function resolveStaticFile(root: string, requestPath: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(requestPath);
    } catch {
        return null;
    }
    const resolved = path.join(root, decoded);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    if (decoded === '/' || decoded === '') return null;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    return null;
}

function resolveSendfile(root: string, file: string): string | null {
    const resolved = path.resolve(root, file);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
    return resolved;
}

async function toEnvelopeRequest(request: Request): Promise<EnvelopeRequest> {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? new Uint8Array(await request.buffer()) : new Uint8Array(0);
    const xff = request.headers['x-forwarded-for'];
    const clientIp =
        typeof xff === 'string' && xff.length > 0 ? xff.split(',')[0]!.trim() : '127.0.0.1';
    return {
        method: request.method,
        path: request.url,
        headers: Object.entries(request.headers),
        body,
        clientIp,
    };
}

function sendWasmResponse(
    response: Response,
    root: string,
    result: {
        status: number;
        headers: readonly (readonly [string, string])[];
        body: Uint8Array;
        sendfile: string | null;
    },
): void {
    response.status(result.status);
    let hasContentType = false;
    for (const [name, value] of result.headers) {
        if (name.toLowerCase() === 'content-type') hasContentType = true;
        response.header(name, value);
    }
    response.header('server', 'toil');

    if (result.sendfile !== null) {
        const file = resolveSendfile(root, result.sendfile);
        if (file === null) {
            response.status(404).send('not found\n');
            return;
        }
        if (!hasContentType) {
            response.header(
                'content-type',
                MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            );
        }
        response.sendFile(file);
        return;
    }

    if (!hasContentType) response.header('content-type', 'text/plain; charset=utf-8');
    response.send(Buffer.from(result.body.buffer, result.body.byteOffset, result.body.length));
}

function sendSsr(response: Response, out: SsrResult, headOnly: boolean): void {
    response.status(out.status);
    let hasContentType = false;
    for (const [name, value] of out.headers) {
        if (name.toLowerCase() === 'content-type') hasContentType = true;
        response.header(name, value);
    }
    if (!hasContentType) response.header('content-type', 'text/html; charset=utf-8');
    response.header('server', 'toil');
    if (headOnly) {
        response.send('');
        return;
    }
    response.send(Buffer.from(out.html.buffer, out.html.byteOffset, out.html.length));
}

function parseSlotsManifest(
    slotsFile: string,
): { entries: { id: number; offset: number }[]; hash: Uint8Array } | null {
    const bin = fs.readFileSync(slotsFile);
    if (bin.length < 46) return null;
    if (bin.subarray(0, 4).toString('ascii') !== 'TSLT') return null;
    const n = bin.readUInt16LE(44);
    if (bin.length < 46 + n * 8) return null;
    const entries: { id: number; offset: number }[] = [];
    let o = 46;
    for (let i = 0; i < n; i++) {
        entries.push({ offset: bin.readUInt32LE(o), id: bin.readUInt16LE(o + 4) });
        o += 8;
    }
    return { entries, hash: Buffer.from(bin.subarray(12, 44)) };
}

function isTemplateIndexEntry(value: unknown): value is TemplateIndexEntry {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.route === 'string' && typeof v.name === 'string';
}

/** Loads built SSR templates from `<staticRoot>/_ssr/templates.json`. */
export function loadBuiltSsrTemplates(staticRoot: string): DevSsrTemplate[] {
    const ssrDir = path.join(staticRoot, '_ssr');
    const indexFile = path.join(ssrDir, 'templates.json');
    if (!fs.existsSync(indexFile)) return [];
    let index: unknown;
    try {
        index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch {
        return [];
    }
    if (!Array.isArray(index)) return [];

    const out: DevSsrTemplate[] = [];
    for (const item of index) {
        if (!isTemplateIndexEntry(item)) continue;
        if (!/^[A-Za-z0-9_]+$/.test(item.name)) continue;
        const tmplFile = path.join(ssrDir, `${item.name}.tmpl`);
        const slotsFile = path.join(ssrDir, `${item.name}.slots`);
        if (!fs.existsSync(tmplFile) || !fs.existsSync(slotsFile)) continue;
        const parsed = parseSlotsManifest(slotsFile);
        if (parsed === null) continue;
        out.push({
            pattern: item.route,
            name: item.name,
            tmpl: fs.readFileSync(tmplFile),
            entries: parsed.entries,
            hash: parsed.hash,
        });
    }
    return out;
}

/**
 * Starts a built toil app. Requests are served in this order:
 * 1. concrete static files from `staticRoot`,
 * 2. wasm `handle()` for API/server routes,
 * 3. wasm `render()` + `_ssr` template assembly for SSR routes,
 * 4. SPA fallback to `index.html`.
 */
export async function startBuiltServer(options: BuiltServerOptions): Promise<RunningBuiltServer> {
    const port = options.port ?? 3000;
    const host = options.host ?? '127.0.0.1';
    const wsPath = options.wsPath ?? '/_toil';
    const cors = options.cors ?? true;
    const projectRoot = path.resolve(options.root);
    const staticRoot = path.resolve(options.staticRoot);
    const indexHtml = path.join(staticRoot, 'index.html');
    if (!fs.existsSync(indexHtml)) {
        throw new Error(`No build found in ${staticRoot}. Run \`toiljs build\` first.`);
    }

    const emailInit = initEmailService(projectRoot, options.email);
    if (emailInit.service !== null) {
        process.stdout.write(pc.dim(`  email enabled: ${emailInit.note}`) + '\n');
    } else if (emailInit.note !== null) {
        process.stdout.write(pc.yellow('  ! ') + pc.dim(`email off: ${emailInit.note}`) + '\n');
    }

    const module =
        options.wasmFile !== undefined && fs.existsSync(options.wasmFile)
            ? new WasmServerModule(options.wasmFile)
            : null;
    if (module !== null) {
        try {
            module.refresh();
        } catch (e) {
            process.stdout.write(pc.red(`  x server wasm failed to load: ${String(e)}`) + '\n');
        }
    }

    const ssrRoutes = buildSsrRoutes(loadBuiltSsrTemplates(staticRoot));
    if (ssrRoutes.length > 0) {
        process.stdout.write(
            pc.dim(`  edge SSR: ${String(ssrRoutes.length)} route(s) served server-side`) + '\n',
        );
    }

    configureDbPersistence(path.join(projectRoot, '.toil', 'devdata.json'));

    const app = new Server({
        max_body_length: options.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH,
        max_body_buffer: MAX_BODY_BUFFER,
        fast_abort: true,
        idle_timeout: HTTP_IDLE_TIMEOUT,
        response_timeout: HTTP_RESPONSE_TIMEOUT,
    });

    const clients = new Set<Websocket>();

    app.set_error_handler((_request: Request, response: Response, error: Error) => {
        if (response.completed) return;
        response.atomic(() => {
            response.status(500).send(`internal error: ${error.message}\n`);
        });
    });

    if (cors) {
        app.use((request: Request, response: Response, next: MiddlewareNext) => {
            if (request.method !== 'OPTIONS') {
                response.setHeader('Access-Control-Allow-Origin', '*');
                response.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
                response.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
            }
            response.removeHeader('uWebSockets');
            next();
        });
        app.options('/*', (_request: Request, response: Response) => {
            response.setHeader('Access-Control-Allow-Origin', '*');
            response.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
            response.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
            response.setHeader('Access-Control-Max-Age', '86400');
            response.status(204).send();
        });
    }

    app.ws(
        wsPath,
        {
            message_type: 'String',
            max_payload_length: WS_MAX_PAYLOAD_LENGTH,
            idle_timeout: WS_IDLE_TIMEOUT,
            max_backpressure: WS_MAX_BACKPRESSURE,
        },
        (ws) => {
            clients.add(ws);
            ws.send(JSON.stringify({ type: 'connected', clients: clients.size }));
            ws.on('message', (message: string) => {
                for (const client of clients) client.send(message);
            });
            ws.on('drain', () => {});
            ws.on('close', () => {
                clients.delete(ws);
            });
        },
    );

    app.upgrade(wsPath, (request: Request, response: Response) => {
        if (
            !isWsOriginAllowed(request.headers.origin, request.headers.host, options.allowedOrigins)
        ) {
            response.status(403).send();
            return;
        }
        response.upgrade({});
    });

    app.any('/*', async (request: Request, response: Response) => {
        response.removeHeader('uWebSockets');

        if (request.method === 'GET' || request.method === 'HEAD') {
            const file = resolveStaticFile(staticRoot, request.path);
            if (file !== null) {
                response.sendFile(file);
                return;
            }
        }

        let envelopeReq: EnvelopeRequest | null = null;
        const envelope = async (): Promise<EnvelopeRequest> => {
            envelopeReq ??= await toEnvelopeRequest(request);
            return envelopeReq;
        };

        const dispatchable = METHOD_CODES[request.method] !== undefined;
        if (dispatchable && module !== null && module.available) {
            const req = await envelope();
            const cacheHost = request.headers.host ?? 'self-host';
            const hasAuth =
                request.headers.cookie !== undefined || request.headers.authorization !== undefined;
            const cached = lookupCache(cacheHost, request.method, request.url, req.body);
            if (cached !== null) {
                sendWasmResponse(response, projectRoot, cached);
                return;
            }
            try {
                const result = module.dispatch(req);
                if (!result.unhandled) {
                    const finalized = applyCacheRule(
                        cacheHost,
                        request.method,
                        request.url,
                        req.body,
                        hasAuth,
                        result,
                    );
                    sendWasmResponse(response, projectRoot, finalized);
                    return;
                }
            } catch (e) {
                process.stdout.write(
                    pc.red(`  x ${request.method} ${request.path} server error: ${String(e)}`) +
                        '\n',
                );
                response.status(500).send('internal error\n');
                return;
            }
        }

        if (request.method === 'GET' || request.method === 'HEAD') {
            const route = ssrRoutes.find((r) => r.test(pathnameOf(request.url)));
            if (route !== undefined) {
                try {
                    const out: SsrResult | null =
                        route.entries.length === 0
                            ? { status: 200, headers: [], html: route.tmpl }
                            : module !== null && module.available
                              ? assembleSsr(route, module.dispatchRender(await envelope()))
                              : null;
                    if (out !== null) {
                        sendSsr(response, out, request.method === 'HEAD');
                        return;
                    }
                } catch (e) {
                    process.stdout.write(pc.red(`  x SSR ${request.path}: ${String(e)}`) + '\n');
                    response.status(500).send('internal error\n');
                    return;
                }
            }

            response.sendFile(indexHtml);
            return;
        }

        response.status(404).send('not found\n');
    });

    await app.listen(port, host);

    return {
        port,
        host,
        wsPath,
        broadcast: (message: string): void => {
            for (const client of clients) client.send(message);
        },
        clientCount: (): number => clients.size,
        close: async (): Promise<void> => {
            await app.shutdown();
        },
    };
}

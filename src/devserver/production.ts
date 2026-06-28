/**
 * Built-app self-host server: static assets + ToilScript wasm dispatch + edge
 * SSR template assembly. This is the production counterpart to the dev front
 * server, except the fallback is the built client directory instead of Vite.
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    type MiddlewareNext,
    type Request,
    type Response,
    Server,
    type Websocket,
} from '@dacely/hyper-express';
import pc from 'picocolors';

import type { EmailBackendConfig } from 'toiljs/shared';

import type { ResolvedDaemonConfig } from './daemon/host.js';
import { startDaemonRuntime } from './daemon/runtime.js';
import { configureDbPersistence } from './db/index.js';
import { initEmailService } from './email/index.js';
import {
    assembleRouteSsr,
    dispatchEnvelopeRequest,
    installRuntimeErrorHandler,
    isDispatchableMethod,
    prepareSsrResponse,
    prepareWasmResponse,
    resolveStaticFile,
    runtimeServerOptions,
    toEnvelopeRequest,
} from './http/runtime.js';
import {
    decodeBody,
    encodeBody,
    isWorkerToPrimaryMessage,
    type ThreadedReply,
    type ThreadedRequest,
    type WorkerToPrimaryMessage,
} from './production-ipc.js';
import { WasmServerModule } from './runtime/module.js';
import { buildSsrRoutes, type DevSsrTemplate, pathnameOf, type SsrRoute } from './ssr.js';

const WS_MAX_PAYLOAD_LENGTH = 1024 * 1024;
const WS_IDLE_TIMEOUT = 120;
const WS_MAX_BACKPRESSURE = 1024 * 1024 * 2;

const CORS_METHODS = 'GET, POST, OPTIONS, PUT, PATCH, DELETE';
const CORS_HEADERS = 'X-Requested-With, content-type';

export interface BuiltServerOptions {
    /** Project root; wasm sendfile paths and local data resolve here. */
    readonly root: string;
    /** Built client directory, usually `<root>/build/client`. */
    readonly staticRoot: string;
    /** Built server wasm, usually `<root>/build/server/release.wasm`. */
    readonly wasmFile?: string;
    /** Built cold daemon wasm, usually `<root>/build/server/release-cold.wasm`. */
    readonly coldWasmFile?: string;
    /** Which layer the self-host process emulates. Default `all`. */
    readonly nodeMode?: string;
    /** Daemon (L4) config mirror used by the self-host daemon runtime. */
    readonly daemon?: ResolvedDaemonConfig;
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
    /**
     * Number of production HTTP workers for `toiljs start`. Default `auto`
     * (`os.availableParallelism()`). Set `1` to run a single in-process server.
     */
    readonly threads?: number | 'auto';
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

interface BuiltServerPaths {
    readonly port: number;
    readonly host: string;
    readonly wsPath: string;
    readonly cors: boolean;
    readonly projectRoot: string;
    readonly staticRoot: string;
    readonly indexHtml: string;
}

interface BuiltRuntime {
    readonly projectRoot: string;
    readonly module: WasmServerModule | null;
    readonly ssrRoutes: readonly SsrRoute[];
}

interface BuiltHttpRuntimeOptions {
    readonly onClientCount?: (count: number) => void;
}

type DynamicHandler = (request: Request, response: Response) => Promise<boolean>;

function resolveBuiltServerPaths(options: BuiltServerOptions): BuiltServerPaths {
    const port = options.port ?? 3000;
    const host = options.host ?? '127.0.0.1';
    const wsPath = options.wsPath ?? '/_toil';
    const staticRoot = path.resolve(options.staticRoot);
    const indexHtml = path.join(staticRoot, 'index.html');
    if (!fs.existsSync(indexHtml)) {
        throw new Error(`No build found in ${staticRoot}. Run \`toiljs build\` first.`);
    }
    return {
        port,
        host,
        wsPath,
        cors: options.cors ?? true,
        projectRoot: path.resolve(options.root),
        staticRoot,
        indexHtml,
    };
}

function resolveThreadCount(threads: BuiltServerOptions['threads']): number {
    const raw = process.env.TOILJS_THREADS ?? threads;
    if (raw === undefined || raw === 'auto') return Math.max(1, availableParallelism());
    const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return Math.max(1, availableParallelism());
    return Math.max(1, Math.min(128, Math.floor(n)));
}

function headerValue(
    headers: readonly (readonly [string, string])[],
    name: string,
): string | undefined {
    const lower = name.toLowerCase();
    return headers.find(([k]) => k.toLowerCase() === lower)?.[1];
}

function textReply(status: number, body: string): ThreadedReply {
    return {
        kind: 'response',
        status,
        headers: [['content-type', 'text/plain; charset=utf-8']],
        body: encodeBody(new TextEncoder().encode(body)),
        sendfile: null,
    };
}

function preparedReply(out: {
    readonly status: number;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: Uint8Array;
    readonly sendfile: string | null;
}): ThreadedReply {
    return {
        kind: 'response',
        status: out.status,
        headers: out.headers,
        body: encodeBody(out.body),
        sendfile: out.sendfile,
    };
}

function sendThreadedReply(response: Response, reply: ThreadedReply): boolean {
    if (reply.kind === 'fallback') return false;
    response.status(reply.status);
    for (const [name, value] of reply.headers) response.header(name, value);
    if (reply.sendfile !== null) {
        response.sendFile(reply.sendfile);
        return true;
    }
    const body = decodeBody(reply.body);
    response.send(Buffer.from(body.buffer, body.byteOffset, body.length));
    return true;
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

function createBuiltRuntime(options: BuiltServerOptions, paths: BuiltServerPaths): BuiltRuntime {
    const emailInit = initEmailService(paths.projectRoot, options.email);
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

    const ssrRoutes = buildSsrRoutes(loadBuiltSsrTemplates(paths.staticRoot));
    if (ssrRoutes.length > 0) {
        process.stdout.write(
            pc.dim(`  edge SSR: ${String(ssrRoutes.length)} route(s) served server-side`) + '\n',
        );
    }

    configureDbPersistence(path.join(paths.projectRoot, '.toil', 'devdata.json'));
    return { projectRoot: paths.projectRoot, module, ssrRoutes };
}

function startBuiltDaemon(
    options: BuiltServerOptions,
    paths: BuiltServerPaths,
): { close(): void } | null {
    configureDbPersistence(path.join(paths.projectRoot, '.toil', 'devdata.json'));
    return startDaemonRuntime({
        coldWasmFile: options.coldWasmFile,
        nodeMode: options.nodeMode,
        daemon: options.daemon,
    });
}

async function handleBuiltRuntimeRequest(
    runtime: BuiltRuntime,
    request: ThreadedRequest,
): Promise<ThreadedReply> {
    const envelopeReq = {
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: decodeBody(request.body),
        clientIp: request.clientIp,
    };
    const dispatchable = isDispatchableMethod(request.method);
    if (dispatchable && runtime.module !== null && runtime.module.available) {
        const hasAuth =
            headerValue(request.headers, 'cookie') !== undefined ||
            headerValue(request.headers, 'authorization') !== undefined;
        try {
            const dispatch = dispatchEnvelopeRequest({
                module: runtime.module,
                envelopeReq,
                method: request.method,
                url: request.url,
                cacheHost: headerValue(request.headers, 'host') ?? 'self-host',
                hasAuth,
            });
            if (dispatch.result !== null) {
                return preparedReply(
                    prepareWasmResponse(runtime.projectRoot, dispatch.result, 'toil'),
                );
            }
        } catch (e) {
            process.stdout.write(
                pc.red(`  x ${request.method} ${request.path} server error: ${String(e)}`) + '\n',
            );
            return textReply(500, 'internal error\n');
        }
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
        const route = runtime.ssrRoutes.find((r) => r.test(pathnameOf(request.url)));
        if (route !== undefined) {
            try {
                const out = assembleRouteSsr(route, runtime.module, envelopeReq);
                if (out !== null) {
                    return preparedReply(
                        prepareSsrResponse(out, request.method === 'HEAD', 'toil'),
                    );
                }
            } catch (e) {
                process.stdout.write(pc.red(`  x SSR ${request.path}: ${String(e)}`) + '\n');
                return textReply(500, 'internal error\n');
            }
        }
        return { kind: 'fallback' };
    }

    return textReply(404, 'not found\n');
}

async function startBuiltHttpServer(
    options: BuiltServerOptions,
    paths: BuiltServerPaths,
    dynamicHandler: DynamicHandler,
    runtimeOptions: BuiltHttpRuntimeOptions = {},
): Promise<RunningBuiltServer> {
    const cors = paths.cors;

    const app = new Server(runtimeServerOptions(options));

    const clients = new Set<Websocket>();

    installRuntimeErrorHandler(app);

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
        paths.wsPath,
        {
            message_type: 'String',
            max_payload_length: WS_MAX_PAYLOAD_LENGTH,
            idle_timeout: WS_IDLE_TIMEOUT,
            max_backpressure: WS_MAX_BACKPRESSURE,
        },
        (ws) => {
            clients.add(ws);
            runtimeOptions.onClientCount?.(clients.size);
            ws.send(JSON.stringify({ type: 'connected', clients: clients.size }));
            ws.on('message', (message: string) => {
                for (const client of clients) client.send(message);
            });
            ws.on('drain', () => {});
            ws.on('close', () => {
                clients.delete(ws);
                runtimeOptions.onClientCount?.(clients.size);
            });
        },
    );

    app.upgrade(paths.wsPath, (request: Request, response: Response) => {
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
            const file = resolveStaticFile(paths.staticRoot, request.path);
            if (file !== null) {
                response.sendFile(file);
                return;
            }
        }

        if (await dynamicHandler(request, response)) return;

        if (request.method === 'GET' || request.method === 'HEAD') {
            // Serve the route's OWN prerendered HTML if the build baked one
            // (`<route>/index.html`, written by prerender.ts/ssg.ts with that route's metadata);
            // otherwise fall back to the root shell for client-side routing. Without this per-route
            // lookup EVERY route served the root index.html, so view-source on e.g. /login showed
            // the home page's <head> (title/description/canonical/og) instead of the page's own.
            const routeHtml = resolveStaticFile(paths.staticRoot, `${request.path}/index.html`);
            response.sendFile(routeHtml ?? paths.indexHtml);
            return;
        }

        response.status(404).send('not found\n');
    });

    await app.listen(paths.port, paths.host);

    return {
        port: paths.port,
        host: paths.host,
        wsPath: paths.wsPath,
        broadcast: (message: string): void => {
            for (const client of clients) client.send(message);
        },
        clientCount: (): number => clients.size,
        close: async (): Promise<void> => {
            await app.shutdown();
        },
    };
}

async function toThreadedRequest(request: Request, id: number): Promise<ThreadedRequest> {
    const envelopeReq = await toEnvelopeRequest(request);
    return {
        id,
        method: request.method,
        url: request.url,
        path: request.path,
        headers: envelopeReq.headers,
        body: encodeBody(envelopeReq.body),
        clientIp: envelopeReq.clientIp ?? '127.0.0.1',
    };
}

async function startBuiltServerSingle(options: BuiltServerOptions): Promise<RunningBuiltServer> {
    const paths = resolveBuiltServerPaths(options);
    const runtime = createBuiltRuntime(options, paths);
    const daemon = startBuiltDaemon(options, paths);
    try {
        const server = await startBuiltHttpServer(options, paths, async (request, response) => {
            const reply = await handleBuiltRuntimeRequest(
                runtime,
                await toThreadedRequest(request, 0),
            );
            return sendThreadedReply(response, reply);
        });
        return {
            ...server,
            close: async (): Promise<void> => {
                daemon?.close();
                await server.close();
            },
        };
    } catch (e) {
        daemon?.close();
        throw e;
    }
}

export interface BuiltServerWorkerController {
    request(request: ThreadedRequest): Promise<ThreadedReply>;
    clientCount(count: number): void;
}

export async function startBuiltServerWorker(
    options: BuiltServerOptions,
    controller: BuiltServerWorkerController,
): Promise<RunningBuiltServer> {
    const paths = resolveBuiltServerPaths(options);
    let nextRequestId = 1;
    return startBuiltHttpServer(
        { ...options, threads: 1 },
        paths,
        async (request, response) => {
            const reply = await controller.request(
                await toThreadedRequest(request, nextRequestId++),
            );
            return sendThreadedReply(response, reply);
        },
        { onClientCount: (count) => controller.clientCount(count) },
    );
}

function sendToWorker(worker: ChildProcess, message: object): void {
    try {
        worker.send?.(message);
    } catch {
        // Worker is already gone; the exit handler will respawn or close it.
    }
}

function stopWorker(worker: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        if (worker.exitCode !== null || worker.signalCode !== null) {
            resolve();
            return;
        }
        const hard = setTimeout(() => {
            try {
                worker.kill('SIGTERM');
            } catch {
                // already closed
            }
            resolve();
        }, 1500);
        hard.unref();
        worker.once('exit', () => {
            clearTimeout(hard);
            resolve();
        });
        sendToWorker(worker, { toil: 'shutdown' });
    });
}

async function startThreadedBuiltServer(
    options: BuiltServerOptions,
    threads: number,
): Promise<RunningBuiltServer> {
    const paths = resolveBuiltServerPaths(options);
    const runtime = createBuiltRuntime(options, paths);
    const daemon = startBuiltDaemon(options, paths);
    const workerScript = fileURLToPath(new URL('./production-worker.js', import.meta.url));
    const workers = new Map<number, ChildProcess>();
    const clientCounts = new Map<number, number>();
    let closing = false;

    const handleMessage = (worker: ChildProcess, message: WorkerToPrimaryMessage): void => {
        switch (message.toil) {
            case 'clientCount':
                clientCounts.set(message.workerId, message.count);
                return;
            case 'request':
                void handleBuiltRuntimeRequest(runtime, message.request)
                    .then((reply) =>
                        sendToWorker(worker, {
                            toil: 'reply',
                            id: message.request.id,
                            reply,
                        }),
                    )
                    .catch((e: unknown) =>
                        sendToWorker(worker, {
                            toil: 'reply',
                            id: message.request.id,
                            reply: textReply(500, `internal error: ${String(e)}\n`),
                        }),
                    );
                return;
            case 'ready':
                return;
        }
    };

    const spawnWorker = (workerId: number, initial: boolean): Promise<void> =>
        new Promise((resolve, reject) => {
            const worker = fork(workerScript, [], {
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: process.env,
            });
            workers.set(workerId, worker);
            clientCounts.set(workerId, 0);

            let ready = false;
            const failInitial = (error: Error): void => {
                if (!initial || ready) return;
                reject(error);
            };

            worker.on('message', (value: unknown) => {
                if (!isWorkerToPrimaryMessage(value)) return;
                if (value.toil === 'ready') {
                    ready = true;
                    resolve();
                    return;
                }
                handleMessage(worker, value);
            });
            worker.once('error', (error) => {
                failInitial(error);
            });
            worker.once('exit', (code, signal) => {
                workers.delete(workerId);
                clientCounts.delete(workerId);
                if (closing) return;
                if (!ready) {
                    failInitial(
                        new Error(
                            `production worker ${String(workerId)} exited before listening (code ${String(code)}, signal ${String(signal)})`,
                        ),
                    );
                    return;
                }
                void spawnWorker(workerId, false).catch((e: unknown) => {
                    process.stdout.write(
                        pc.red(
                            `  x production worker ${String(workerId)} restart failed: ${String(e)}`,
                        ) + '\n',
                    );
                });
            });
            sendToWorker(worker, {
                toil: 'start',
                workerId,
                options: { ...options, threads: 1 },
            });
        });

    try {
        await Promise.all(Array.from({ length: threads }, (_, i) => spawnWorker(i + 1, true)));
    } catch (e) {
        closing = true;
        daemon?.close();
        await Promise.all([...workers.values()].map((worker) => stopWorker(worker)));
        throw e;
    }

    process.stdout.write(pc.dim(`  production threads: ${String(threads)} HTTP workers`) + '\n');

    return {
        port: paths.port,
        host: paths.host,
        wsPath: paths.wsPath,
        broadcast: (message: string): void => {
            for (const worker of workers.values()) {
                sendToWorker(worker, { toil: 'broadcast', message });
            }
        },
        clientCount: (): number => {
            let total = 0;
            for (const count of clientCounts.values()) total += count;
            return total;
        },
        close: async (): Promise<void> => {
            closing = true;
            daemon?.close();
            await Promise.all([...workers.values()].map((worker) => stopWorker(worker)));
        },
    };
}

/**
 * Starts a built toil app. Requests are served in this order:
 * 1. concrete static files from `staticRoot`,
 * 2. wasm `handle()` for API/server routes,
 * 3. wasm `render()` + `_ssr` template assembly for SSR routes,
 * 4. SPA fallback to `index.html`.
 */
export async function startBuiltServer(options: BuiltServerOptions): Promise<RunningBuiltServer> {
    const threads = resolveThreadCount(options.threads);
    if (threads <= 1) return startBuiltServerSingle(options);
    return startThreadedBuiltServer(options, threads);
}

/**
 * The toiljs WASM dev server: a uWebSockets.js front (via @dacely/hyper-express,
 * the same stack as `toiljs/backend`) that dispatches HTTP requests into the
 * ToilScript-compiled server wasm exactly like the production edge does, and
 * proxies everything the server does not claim to an internal Vite dev server,
 * so dev keeps 100% of Vite's behavior (HMR, transforms, toolbar endpoints,
 * public assets, SPA fallback).
 *
 * Request flow:
 *
 *   browser ── uWS :port ──► wasm `handle()` (fresh instance, envelope ABI)
 *                 │                │
 *                 │                └─ "unhandled" marker (no route matched)
 *                 ▼                                   │
 *           Vite dev server (loopback) ◄──────────────┘
 *
 * Dev intentionally skips the edge's metering, gas, pooling and snapshot-reset
 * machinery; the ABI (envelope layout, `handle(ofs, len) -> i64`, host import
 * surface, trap isolation) is identical so a server that runs here runs there.
 */

import fs from 'node:fs';
import path from 'node:path';

import { Server, type Request, type Response } from '@dacely/hyper-express';
import pc from 'picocolors';

import { applyCacheRule, lookupCache } from './cache.js';
import { METHOD_CODES, type EnvelopeRequest } from './envelope.js';
import { WasmServerModule } from './module.js';
import { proxyToVite, wireWebsocketProxy, type ViteTarget } from './proxy.js';

export { METHOD_CODES, encodeRequestEnvelope, decodeResponseEnvelope, unpackHandleResult } from './envelope.js';
export type { EnvelopeRequest, EnvelopeResponse } from './envelope.js';
export { WasmServerModule, WasmAbortError, UNHANDLED_HEADER } from './module.js';
export type { WasmDispatchResult } from './module.js';
export { buildHostImports, freshDispatchState } from './host.js';
export type { DispatchState, MemoryRef } from './host.js';
export type { ViteTarget } from './proxy.js';

const DEFAULT_MAX_BODY_LENGTH = 1024 * 1024 * 8;

/**
 * Paths that are Vite's own by construction; skipping the wasm round-trip for
 * them keeps the hot path of module serving untouched. Everything else is
 * offered to the server first (it answers or yields via the unhandled marker).
 */
const VITE_PREFIXES = ['/@', '/node_modules/', '/__toil/'];

/** Minimal type map for `respond_file` bodies when the guest set no content-type. */
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

/** Options for {@link startDevServer}. */
export interface DevServerOptions {
    /** Project root; `respond_file` paths resolve against it (and may not escape it). */
    readonly root: string;
    /** Public listening port (the one the browser opens). */
    readonly port: number;
    /** Bind host. Default `127.0.0.1`. */
    readonly host?: string;
    /** Absolute path to the ToilScript server wasm (toilconfig `targets.release.outFile`). */
    readonly wasmFile: string;
    /** The internal Vite dev server to proxy unclaimed traffic to. */
    readonly vite: ViteTarget;
    /** Max request body bytes. Default 8 MB. */
    readonly maxBodyLength?: number;
}

/** A running dev server. */
export interface RunningDevServer {
    readonly port: number;
    readonly host: string;
    /** Gracefully shuts the front server down (the Vite server is owned by the caller). */
    close(): Promise<void>;
}

/** True for requests that belong to Vite by construction (never offered to the wasm). */
function isViteInternal(url: string): boolean {
    return VITE_PREFIXES.some((p) => url.startsWith(p));
}

/** Resolves a guest `respond_file` path inside `root`, refusing traversal outside it. */
function resolveSendfile(root: string, file: string): string | null {
    const resolved = path.resolve(root, file);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
    return resolved;
}

/** Builds the envelope request for one incoming HTTP request. */
async function toEnvelopeRequest(request: Request): Promise<EnvelopeRequest> {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? new Uint8Array(await request.buffer()) : new Uint8Array(0);
    return {
        method: request.method,
        // `url` keeps the query string; the guest's RouteContext parses it off the path.
        path: request.url,
        headers: Object.entries(request.headers),
        body,
    };
}

/** Sends a shaped wasm response, mirroring the edge's response defaults. */
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
    response.header('server', 'toil-dev');

    if (result.sendfile !== null) {
        const file = resolveSendfile(root, result.sendfile);
        if (file === null) {
            response.status(404).send('not found\n');
            return;
        }
        if (!hasContentType) {
            // The edge defaults file bodies to application/octet-stream; in dev we
            // guess from the extension so a guest-served asset renders in the browser.
            response.header('content-type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
        }
        response.sendFile(file);
        return;
    }

    if (!hasContentType) response.header('content-type', 'text/plain; charset=utf-8');
    response.send(Buffer.from(result.body.buffer, result.body.byteOffset, result.body.length));
}

/**
 * Starts the front server. The caller owns the Vite dev server (start it on a
 * loopback port first) and the toilscript rebuild watcher; this watches only
 * the wasm artifact and hot-swaps the compiled module when it changes.
 */
export async function startDevServer(options: DevServerOptions): Promise<RunningDevServer> {
    const host = options.host ?? '127.0.0.1';
    const root = path.resolve(options.root);
    const module = new WasmServerModule(options.wasmFile);

    let warnedMissing = false;
    let loadedOnce = false;
    const refresh = (): void => {
        try {
            if (module.refresh() && loadedOnce) {
                process.stdout.write(pc.green('  ✓ ') + pc.dim('server module reloaded') + '\n');
            }
            loadedOnce ||= module.available;
        } catch (e) {
            process.stdout.write(pc.red(`  ✗ server wasm failed to load: ${String(e)}`) + '\n');
        }
        if (!module.available && !warnedMissing) {
            warnedMissing = true;
            process.stdout.write(
                pc.yellow('  ! ') +
                    pc.dim(`server wasm not found at ${options.wasmFile}; serving client only`) +
                    '\n',
            );
        }
    };
    refresh();

    const app = new Server({
        max_body_length: options.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH,
        max_body_buffer: 1024 * 32,
        fast_abort: true,
    });

    app.set_error_handler((_request: Request, response: Response, error: Error) => {
        if (response.completed) return;
        response.atomic(() => {
            response.status(500).send(`internal error: ${error.message}\n`);
        });
    });

    wireWebsocketProxy(app, options.vite);

    app.any('/*', async (request: Request, response: Response) => {
        response.removeHeader('uWebSockets');

        const dispatchable =
            !isViteInternal(request.url) && METHOD_CODES[request.method] !== undefined;
        if (dispatchable) refresh();

        if (dispatchable && module.available) {
            const envelopeReq = await toEnvelopeRequest(request);
            // Honor the tenant cache directive locally, same rules as the
            // edge: serve an identical request from the per-process cache,
            // else dispatch and apply/strip the directive on the response.
            const cacheHost = request.headers.host ?? 'dev';
            const hasAuth =
                request.headers.cookie !== undefined || request.headers.authorization !== undefined;
            const cached = lookupCache(cacheHost, request.method, request.url, envelopeReq.body);
            if (cached !== null) {
                sendWasmResponse(response, root, cached);
                return;
            }
            try {
                const result = module.dispatch(envelopeReq);
                if (!result.unhandled) {
                    const finalized = applyCacheRule(
                        cacheHost,
                        request.method,
                        request.url,
                        envelopeReq.body,
                        hasAuth,
                        result,
                    );
                    sendWasmResponse(response, root, finalized);
                    return;
                }
            } catch (e) {
                // A trap (ToilScript abort, OOB, malformed envelope) is isolated to
                // this request, exactly like the edge poisoning one instance.
                process.stdout.write(
                    pc.red(`  ✗ ${request.method} ${request.path} server error: ${String(e)}`) + '\n',
                );
                response.status(500).send('internal error\n');
                return;
            }
        }

        await proxyToVite(request, response, options.vite);
    });

    await app.listen(options.port, host);

    return {
        port: options.port,
        host,
        close: async (): Promise<void> => {
            await app.shutdown();
        },
    };
}

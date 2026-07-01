import fs from 'node:fs';
import path from 'node:path';

import { type Request, type Response, type Server } from '@dacely/hyper-express';
import pc from 'picocolors';

import { type EnvelopeRequest, METHOD_CODES } from './envelope.js';
import { applyCacheRule, lookupCache, type CacheableResult } from './cache.js';
import { type WasmDispatchResult, WasmServerModule } from '../runtime/module.js';
import { assembleSsr, type SsrResult, type SsrRoute } from '../ssr.js';

export const DEFAULT_MAX_BODY_LENGTH = 1024 * 1024 * 8;
export const MAX_BODY_BUFFER = 1024 * 32;
export const HTTP_IDLE_TIMEOUT = 60;
export const HTTP_RESPONSE_TIMEOUT = 120;

export const MIME: Readonly<Record<string, string>> = {
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

export interface RuntimeServerOptions {
    readonly maxBodyLength?: number;
}

export function runtimeServerOptions(options: RuntimeServerOptions): {
    max_body_length: number;
    max_body_buffer: number;
    fast_abort: true;
    idle_timeout: number;
    response_timeout: number;
} {
    return {
        max_body_length: options.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH,
        max_body_buffer: MAX_BODY_BUFFER,
        fast_abort: true,
        idle_timeout: HTTP_IDLE_TIMEOUT,
        response_timeout: HTTP_RESPONSE_TIMEOUT,
    };
}

export function installRuntimeErrorHandler(app: Server): void {
    app.set_error_handler((_request: Request, response: Response, error: Error) => {
        if (response.completed) return;
        response.atomic(() => {
            response.status(500).send(`internal error: ${error.message}\n`);
        });
    });
}

export function isDispatchableMethod(method: string): boolean {
    return METHOD_CODES[method] !== undefined;
}

export function resolveFileInside(root: string, file: string): string | null {
    const resolved = path.resolve(root, file);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
    return resolved;
}

export function resolveStaticFile(root: string, requestPath: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(requestPath);
    } catch {
        return null;
    }
    if (decoded === '/' || decoded === '') return null;
    return resolveFileInside(root, decoded.replace(/^\/+/, ''));
}

// --- Dynamic bracket-template routing (mirrors the toil-backend edge) ---------
//
// The build emits a dynamic route `blog/[id].tsx` as a literal `blog/[id].html`
// template that boots the SPA for any concrete `/blog/<x>`. When no exact file
// matches, walk the URL segments and, at each directory, serve a bracket sibling
// using the client router's precedence: a real subdir wins (static > dynamic),
// then `[x].html` (one segment), then `[x]/` (descend), then `[...x].html` (1+),
// then `[[...x]].html` (0+). Directory scans are memoized.

interface DirDynamic {
    singleFile: string | null;
    singleDir: string | null;
    catchall: string | null;
    optCatchall: string | null;
}

const dynDirCache = new Map<string, DirDynamic>();

function classifyBracket(name: string, isDir: boolean): keyof DirDynamic | null {
    if (isDir) {
        if (name.startsWith('[') && name.endsWith(']') && !name.includes('...') && name.length > 2)
            return 'singleDir';
        return null;
    }
    if (!name.endsWith('.html')) return null;
    const stem = name.slice(0, -'.html'.length);
    if (stem.startsWith('[[...') && stem.endsWith(']]') && stem.length > 7) return 'optCatchall';
    if (stem.startsWith('[...') && stem.endsWith(']') && stem.length > 5) return 'catchall';
    if (stem.startsWith('[') && stem.endsWith(']') && !stem.startsWith('[..') && stem.length > 2)
        return 'singleFile';
    return null;
}

function scanDirDynamic(absDir: string): DirDynamic {
    const cached = dynDirCache.get(absDir);
    if (cached) return cached;
    const d: DirDynamic = { singleFile: null, singleDir: null, catchall: null, optCatchall: null };
    try {
        for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
            const kind = classifyBracket(e.name, e.isDirectory());
            if (kind === null) continue;
            const cur = d[kind];
            if (cur === null || e.name < cur) d[kind] = e.name;
        }
    } catch {
        // missing/unreadable directory: no templates
    }
    dynDirCache.set(absDir, d);
    return d;
}

const joinRel = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

function isDirInside(root: string, rel: string): boolean {
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;
    try {
        return fs.statSync(resolved).isDirectory();
    } catch {
        return false;
    }
}

function resolveDynamicWalk(root: string, dir: string, segs: string[], i: number): string | null {
    if (i >= segs.length) {
        // Nothing left: only an optional catch-all (0 segments) serves the bare dir.
        const oc = scanDirDynamic(path.join(root, dir)).optCatchall;
        return oc === null ? null : joinRel(dir, oc);
    }
    const isLast = i + 1 === segs.length;
    // A real static subdirectory wins over any dynamic template at this level.
    const child = joinRel(dir, segs[i]);
    if (isDirInside(root, child)) {
        const r = resolveDynamicWalk(root, child, segs, i + 1);
        if (r !== null) return r;
    }
    const d = scanDirDynamic(path.join(root, dir));
    if (isLast && d.singleFile !== null) return joinRel(dir, d.singleFile);
    if (d.singleDir !== null) {
        const r = resolveDynamicWalk(root, joinRel(dir, d.singleDir), segs, i + 1);
        if (r !== null) return r;
    }
    if (d.catchall !== null) return joinRel(dir, d.catchall);
    if (d.optCatchall !== null) return joinRel(dir, d.optCatchall);
    return null;
}

/** Resolve a request path to a bracket-template file (`blog/[id].html`) if one matches, else null. */
export function resolveDynamicFile(root: string, requestPath: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(requestPath);
    } catch {
        return null;
    }
    const segs = decoded.split('/').filter(Boolean);
    const rel = resolveDynamicWalk(root, '', segs, 0);
    return rel === null ? null : resolveFileInside(root, rel);
}

export interface PreparedHttpResponse {
    readonly status: number;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: Uint8Array;
    readonly sendfile: string | null;
}

export async function toEnvelopeRequest(request: Request): Promise<EnvelopeRequest> {
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

export function prepareWasmResponse(
    root: string,
    result: Pick<CacheableResult, 'status' | 'headers' | 'body' | 'sendfile'>,
    serverHeader: string,
): PreparedHttpResponse {
    const headers: (readonly [string, string])[] = [];
    let hasContentType = false;
    for (const [name, value] of result.headers) {
        if (name.toLowerCase() === 'content-type') hasContentType = true;
        headers.push([name, value]);
    }
    headers.push(['server', serverHeader]);

    if (result.sendfile !== null) {
        const file = resolveFileInside(root, result.sendfile);
        if (file === null) {
            return {
                status: 404,
                headers: [
                    ['server', serverHeader],
                    ['content-type', 'text/plain; charset=utf-8'],
                ],
                body: new TextEncoder().encode('not found\n'),
                sendfile: null,
            };
        }
        if (!hasContentType) {
            headers.push([
                'content-type',
                MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            ]);
        }
        return { status: result.status, headers, body: new Uint8Array(0), sendfile: file };
    }

    if (!hasContentType) headers.push(['content-type', 'text/plain; charset=utf-8']);
    return { status: result.status, headers, body: result.body, sendfile: null };
}

export function sendPreparedResponse(response: Response, out: PreparedHttpResponse): void {
    response.status(out.status);
    for (const [name, value] of out.headers) response.header(name, value);
    if (out.sendfile !== null) {
        response.sendFile(out.sendfile);
        return;
    }
    response.send(Buffer.from(out.body.buffer, out.body.byteOffset, out.body.length));
}

export function sendWasmResponse(
    response: Response,
    root: string,
    result: Pick<CacheableResult, 'status' | 'headers' | 'body' | 'sendfile'>,
    serverHeader: string,
): void {
    sendPreparedResponse(response, prepareWasmResponse(root, result, serverHeader));
}

export function prepareSsrResponse(
    out: SsrResult,
    headOnly: boolean,
    serverHeader: string,
): PreparedHttpResponse {
    const headers: (readonly [string, string])[] = [];
    let hasContentType = false;
    for (const [name, value] of out.headers) {
        if (name.toLowerCase() === 'content-type') hasContentType = true;
        headers.push([name, value]);
    }
    if (!hasContentType) headers.push(['content-type', 'text/html; charset=utf-8']);
    headers.push(['server', serverHeader]);
    return {
        status: out.status,
        headers,
        body: headOnly ? new Uint8Array(0) : out.html,
        sendfile: null,
    };
}

export function sendSsr(
    response: Response,
    out: SsrResult,
    headOnly: boolean,
    serverHeader: string,
): void {
    sendPreparedResponse(response, prepareSsrResponse(out, headOnly, serverHeader));
}

export interface WasmDispatchOutcome {
    readonly envelopeReq: EnvelopeRequest;
    readonly handled: boolean;
}

export interface EnvelopeDispatchOutcome {
    readonly result: CacheableResult | null;
    readonly handled: boolean;
}

export function dispatchEnvelopeRequest(options: {
    readonly module: WasmServerModule;
    readonly envelopeReq: EnvelopeRequest;
    readonly method: string;
    readonly url: string;
    readonly cacheHost: string;
    readonly hasAuth: boolean;
}): EnvelopeDispatchOutcome {
    const cached = lookupCache(
        options.cacheHost,
        options.method,
        options.url,
        options.envelopeReq.body,
    );
    if (cached !== null) return { result: cached, handled: true };

    const result = options.module.dispatch(options.envelopeReq);
    if (result.unhandled) return { result: null, handled: false };

    return {
        result: applyCacheRule(
            options.cacheHost,
            options.method,
            options.url,
            options.envelopeReq.body,
            options.hasAuth,
            result,
        ),
        handled: true,
    };
}

export async function dispatchWasmRequest(options: {
    readonly module: WasmServerModule;
    readonly request: Request;
    readonly response: Response;
    readonly root: string;
    readonly cacheHost: string;
    readonly serverHeader: string;
    readonly errorPrefix: string;
}): Promise<WasmDispatchOutcome> {
    const envelopeReq = await toEnvelopeRequest(options.request);
    const hasAuth =
        options.request.headers.cookie !== undefined ||
        options.request.headers.authorization !== undefined;

    try {
        const dispatch = dispatchEnvelopeRequest({
            module: options.module,
            envelopeReq,
            method: options.request.method,
            url: options.request.url,
            cacheHost: options.cacheHost,
            hasAuth,
        });
        if (dispatch.result !== null) {
            sendWasmResponse(options.response, options.root, dispatch.result, options.serverHeader);
            return { envelopeReq, handled: true };
        }
    } catch (e) {
        process.stdout.write(
            pc.red(
                `  ${options.errorPrefix} ${options.request.method} ${options.request.path} server error: ${String(e)}`,
            ) + '\n',
        );
        options.response.status(500).send('internal error\n');
        return { envelopeReq, handled: true };
    }

    return { envelopeReq, handled: false };
}

export function assembleRouteSsr(
    route: SsrRoute,
    module: WasmServerModule | null,
    envelopeReq: EnvelopeRequest,
): SsrResult | null {
    if (route.entries.length === 0) return { status: 200, headers: [], html: route.tmpl };
    if (module === null || !module.available) return null;
    return assembleSsr(route, module.dispatchRender(envelopeReq));
}

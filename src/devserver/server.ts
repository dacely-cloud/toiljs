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

import path from 'node:path';

import { Server } from '@dacely/hyper-express';
import pc from 'picocolors';

import type { EmailBackendConfig } from 'toiljs/shared';

import type { ResolvedDaemonConfig } from './daemon/host.js';
import { startDaemonRuntime } from './daemon/runtime.js';
import { configureDbPersistence } from './db/index.js';
import { initEmailService } from './email/index.js';
import { proxyToVite, type ViteTarget, wireWebsocketProxy } from './http/proxy.js';
import {
    assembleRouteSsr,
    dispatchWasmRequest,
    installRuntimeErrorHandler,
    isDispatchableMethod,
    runtimeServerOptions,
    sendSsr,
} from './http/runtime.js';
import { WasmServerModule } from './runtime/module.js';
import { StreamRouter } from './stream/router.js';
import { streamEmulationEnabled, wireStreams } from './stream/wire.js';
import { buildSsrRoutes, type DevSsrTemplate, pathnameOf } from './ssr.js';

/**
 * Paths that are Vite's own by construction; skipping the wasm round-trip for
 * them keeps the hot path of module serving untouched. Everything else is
 * offered to the server first (it answers or yields via the unhandled marker).
 */
const VITE_PREFIXES = ['/@', '/node_modules/', '/__toil/'];

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
    /**
     * Absolute path to the cold daemon artifact (`release-cold.wasm`). When present and the cold
     * artifact declares a daemon surface, the dev daemon emulator drives its `@scheduled` tasks
     * (per `nodeMode`). Omit for a project with no `@daemon` (the file is never built).
     */
    readonly coldWasmFile?: string;
    /**
     * Absolute path to the stream artifact (`release-stream.wasm`). When present and this dev process
     * serves streams (`nodeMode` regional/continental/all), the dev stream router (doc 08 4.1) serves
     * `@stream`-route WebSocket upgrades. Omit for a project with no `@stream` (the file is never built).
     */
    readonly streamWasmFile?: string;
    /** Which layer the dev process emulates (gates the daemon + stream emulators). Default `all`. */
    readonly nodeMode?: string;
    /** Daemon (L4) config mirror (drives the dev scheduler's budgets/caps). */
    readonly daemon?: ResolvedDaemonConfig;
    /** The internal Vite dev server to proxy unclaimed traffic to. */
    readonly vite: ViteTarget;
    /** Max request body bytes. Default 8 MB. */
    readonly maxBodyLength?: number;
    /**
     * The `toil.config.ts` `server.email` section (non-secret). When set (and the
     * API key is in `.env.secrets`), `EmailService.send` really sends in dev;
     * otherwise it stays a log-only mock. See `./email`.
     */
    readonly email?: EmailBackendConfig;
    /**
     * Edge-SSR templates (one per `ssr = true` route), extracted at dev startup
     * against the live dev shell. When a GET/HEAD matches a route the dev server
     * runs the guest `render`, splices the values, and serves the SSR HTML (same
     * path as the prod edge). Omit / empty for a project with no SSR route.
     */
    readonly ssrTemplates?: readonly DevSsrTemplate[];
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

/**
 * Starts the front server. The caller owns the Vite dev server (start it on a
 * loopback port first) and the toilscript rebuild watcher; this watches only
 * the wasm artifact and hot-swaps the compiled module when it changes.
 */
export async function startDevServer(options: DevServerOptions): Promise<RunningDevServer> {
    const host = options.host ?? '127.0.0.1';
    const root = path.resolve(options.root);

    // Wire the email service from toil.config `server.email` + `.env.secrets`
    // (TOIL_EMAIL_*). Configured -> real sends; otherwise the import stays a
    // log-only mock. A partial-but-invalid config logs why it stayed off.
    const emailInit = initEmailService(root, options.email);
    if (emailInit.service !== null) {
        process.stdout.write(pc.dim(`  ✉ email enabled: ${emailInit.note}`) + '\n');
    } else if (emailInit.note !== null) {
        process.stdout.write(pc.yellow('  ! ') + pc.dim(`email off: ${emailInit.note}`) + '\n');
    }

    const module = new WasmServerModule(options.wasmFile);

    // Edge-SSR routes (extracted against the live dev shell at startup). When a
    // GET/HEAD matches one, the dev server runs the guest `render`, splices the
    // values into the template, and serves the SSR HTML (prod-edge parity).
    const ssrRoutes = buildSsrRoutes(options.ssrTemplates ?? []);
    if (ssrRoutes.length > 0) {
        process.stdout.write(
            pc.dim(`  edge SSR: ${String(ssrRoutes.length)} route(s) served server-side`) + '\n',
        );
    }

    // Persist dev DB data under the project's .toil/ so records, events, and their
    // schema_versions survive restarts (delete .toil/devdata.json to reset). Only
    // the running dev server persists; tests that construct WasmServerModule
    // directly stay purely in-memory.
    configureDbPersistence(path.join(root, '.toil', 'devdata.json'));

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

    const app = new Server(runtimeServerOptions(options));
    installRuntimeErrorHandler(app);

    const nodeMode = options.nodeMode ?? 'all';

    // Dev STREAM (L2/L3) emulation (doc 08 4.1): when a stream artifact is built AND this dev process
    // serves streams, route `@stream`-route WebSocket upgrades to the resident-box stream router and
    // proxy everything else (Vite HMR) upstream; otherwise the plain Vite proxy (existing behaviour).
    if (options.streamWasmFile !== undefined && streamEmulationEnabled(nodeMode)) {
        wireStreams(app, options.vite, new StreamRouter(options.streamWasmFile));
    } else {
        wireWebsocketProxy(app, options.vite);
    }

    const daemon = startDaemonRuntime({
        coldWasmFile: options.coldWasmFile,
        nodeMode,
        daemon: options.daemon,
    });

    app.any('/*', async (request, response) => {
        response.removeHeader('uWebSockets');

        const dispatchable = !isViteInternal(request.url) && isDispatchableMethod(request.method);
        if (dispatchable) refresh();

        if (dispatchable && module.available) {
            const dispatch = await dispatchWasmRequest({
                module,
                request,
                response,
                root,
                cacheHost: request.headers.host ?? 'dev',
                serverHeader: 'toil-dev',
                errorPrefix: '✗',
            });
            if (dispatch.handled) {
                return;
            }

            // Edge SSR: handle() did not claim this path; if it matches an
            // `ssr = true` route, run the guest `render`, splice the values, and
            // serve the server-rendered HTML. A fail-safe envelope (no renderer
            // matched / malformed) returns null, so we fall through to Vite (the
            // route then client-renders, same as before).
            if ((request.method === 'GET' || request.method === 'HEAD') && ssrRoutes.length > 0) {
                const route = ssrRoutes.find((r) => r.test(pathnameOf(request.url)));
                if (route) {
                    try {
                        // A static route (its template has no holes -> no slots) needs no guest
                        // render: serve the prerendered template directly so it paints instantly
                        // instead of falling through to a (blank-until-JS) client render. Dynamic
                        // routes run the guest `render` and splice its values in.
                        const out = assembleRouteSsr(route, module, dispatch.envelopeReq);
                        if (out !== null) {
                            sendSsr(response, out, request.method === 'HEAD', 'toil-dev');
                            return;
                        }
                    } catch (e) {
                        process.stdout.write(
                            pc.red(`  ✗ SSR ${request.path}: ${String(e)}`) + '\n',
                        );
                    }
                }
            }
        }

        await proxyToVite(request, response, options.vite);
    });

    await app.listen(options.port, host);

    return {
        port: options.port,
        host,
        close: async (): Promise<void> => {
            daemon?.close();
            await app.shutdown();
        },
    };
}

import { devEnvGet } from '../config/env.js';
import { prepareGoogleKeys } from './google.js';
import { deriveChangesFrame, fullRescanFrame } from '../db/changes.js';
import type { DbDevState } from '../db/types.js';
import { deriveContinuationKey, deriveCheckpointKey } from '../db/derives.js';
/**
 * Loads the ToilScript-compiled server wasm and dispatches request envelopes
 * into it, the dev-mode equivalent of the edge's fresh dispatcher
 * (`toil-backend/src/wasm/dispatcher/fresh.rs`): one fresh instance per
 * request, so guest state can never leak between requests and a trapped
 * instance is simply dropped. Instantiation of a compiled module is
 * microseconds, irrelevant next to dev-mode I/O.
 *
 * The compiled module is cached and transparently recompiled when the wasm
 * file's mtime changes (the `toiljs dev` watcher rebuilds it via toilscript on
 * server-source edits), which is the server-side hot reload.
 */

import fs from 'node:fs';

import {
    commitDeriveCheckpoints,
    DbFunctionKind,
    type DeriveEntry,
    derivesForWrites,
    parseDerives,
    persistDb,
    setDbCatalog,
} from '../db/index.js';
import {
    parseRouteKinds,
    parseRpcKinds,
    routeKindForRequest,
    rpcKindForId,
    type RouteKindEntry,
    type RpcKindEntry,
} from '../db/routeKinds.js';
import {
    decodeResponseEnvelope,
    encodeRequestEnvelope,
    type EnvelopeRequest,
    unpackHandleResult,
} from '../http/envelope.js';
import { buildHostImports, freshDispatchState, type MemoryRef } from './host.js';
import { envelopeWindowOf } from '../wasm/envelope-window.js';
import { registerMaterializer, unregisterMaterializer } from '../db/materialization.js';

export { WasmAbortError } from './host.js';

/**
 * Marker header the server runtime puts on its fallback 404 (no `@rest` route
 * matched and no custom handler produced a response). The dev server strips it
 * and falls through to Vite; a deliberate `Response.notFound()` does not carry
 * it and is sent to the client as-is. Mirrors `TOIL_UNHANDLED_HEADER` in
 * `server/runtime/response.ts`.
 */
export const UNHANDLED_HEADER = 'x-toil-unhandled';

const WASM_PAGE = 65536;

function dbKindForHttpMethod(method: string): DbFunctionKind {
    switch (method.toUpperCase()) {
        case 'GET':
        case 'HEAD':
        case 'OPTIONS':
            return DbFunctionKind.Query;
        case 'POST':
        case 'PUT':
        case 'PATCH':
        case 'DELETE':
        default:
            return DbFunctionKind.Action;
    }
}

export function dbFunctionKindForRequest(
    routes: readonly RouteKindEntry[],
    method: string,
    path: string,
): DbFunctionKind {
    const routeKind = routeKindForRequest(routes, method, path);
    return routeKind === DbFunctionKind.Query ? DbFunctionKind.Query : dbKindForHttpMethod(method);
}

/** The shaped outcome of one guest dispatch. */
export interface WasmDispatchResult {
    readonly status: number;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: Uint8Array;
    /** Path from a guest `respond_file` call; when set it replaces `body`. */
    readonly sendfile: string | null;
    /** True when the guest reported "no route matched" (the {@link UNHANDLED_HEADER} marker). */
    readonly unhandled: boolean;
}

export interface DatabaseInterleavingPoint {
    readonly request: EnvelopeRequest;
    readonly operation: string;
    readonly collection: string | null;
    readonly key: Uint8Array | null;
}
export interface DispatchInterleaving {
    beforeDatabaseOperation?(point: DatabaseInterleavingPoint): void | Promise<void>;
    afterDatabaseOperation?(
        point: DatabaseInterleavingPoint & { readonly result: number | bigint },
    ): void | Promise<void>;
}
interface PromiseIntegration {
    Suspending: new (
        implementation: (...args: number[]) => Promise<number | bigint>,
    ) => WebAssembly.ImportValue;
    promising(
        fn: (offset: number, length: number) => bigint,
    ): (offset: number, length: number) => Promise<bigint>;
}

interface HandleExports {
    readonly memory: WebAssembly.Memory;
    readonly handle: (reqOfs: number, reqLen: number) => bigint;
}

/** A `@database` with `@derive` methods exports `derive_run` (optional: absent
 *  when the program declares no derive). See toilscript `injectDeriveHandler`. */
interface DeriveExports {
    readonly memory: WebAssembly.Memory;
    readonly derive_run?: (deriveId: number) => bigint;
}

/** Host functions the dev server provides under `env` (see `host.ts`). */
const PROVIDED_IMPORTS = new Set([
    'codec.base64url_encode',
    'codec.base64url_decode',
    'abort',
    'set_status',
    'set_header',
    'respond_file',
    'thread_spawn',
    'Date.now',
    'server_log',
    'client_ip',
    'ratelimit_check',
    'google_verify',
    'email_send',
    'email_send_detached',
    'env_get',
    'env_get_secure',
    // Per-domain analytics (see ./analytics/index.ts).
    'analytics_read',
    'analytics_series',
    'analytics_list_sites',
    // Web Crypto host functions (see ./crypto.ts).
    'crypto.fill_random',
    'crypto.random_uuid',
    'crypto.take_result',
    'crypto.digest',
    'crypto.import_key',
    'crypto.export_key',
    'crypto.encrypt',
    'crypto.decrypt',
    'crypto.sign',
    'crypto.verify',
    'crypto.derive_bits',
    'crypto.mldsa_verify',
    'crypto.totp_verify',
    'crypto.mlkem_decapsulate',
    'crypto.voprf_evaluate',
    // ToilDB data API (see ./database.ts). Backed by persistent ToilDB on the production
    // edge; backs the auth example's accounts + login challenges in dev.
    'data.resolve_collection',
    'data.get',
    'data.get_many',
    'data.exists',
    'data.create',
    'data.patch',
    'data.upsert',
    'data.delete',
    'data.get_delete',
    'data.unique_lookup',
    'data.unique_claim',
    'data.unique_release',
    'data.view_get',
    'data.view_publish',
    'data.view_delete',
    'data.membership_contains',
    'data.membership_add',
    'data.membership_remove',
    'data.membership_list',
    'data.membership_page',
    'data.documents_scan',
    'data.atomic_get',
    'data.atomic_batch',
    'image.process',
    'image.take_result',
    'data.counter_get',
    'data.counter_add',
    'data.append',
    'data.append_once',
    'data.enqueue',
    'data.compare_exchange',
    'data.compare_delete',
    'data.get_current',
    'data.latest',
    'data.events_since',
    'data.events_get',
    'data.events_reference',
    'data.events_redact',
    'data.events_entries',
    'data.events_last',
    'data.capacity_set_total',
    'data.capacity_available',
    'data.capacity_reserve',
    'data.capacity_confirm',
    'data.capacity_cancel',
    'data.take_result',
    'data.result_schema_version',
    'data.write_allowed',
    'data.job_allowed',
    'data.budget',
    'data.changes',
    'data.begin_derive',
    'data.end_derive',
    'data.continue_derive',
]);

export class WasmServerModule {
    private module: WebAssembly.Module | null = null;
    private usesGoogleVerification = false;
    private loadedMtimeMs = -1;
    private routeKinds: readonly RouteKindEntry[] = [];
    private rpcKinds: readonly RpcKindEntry[] = [];
    private derives: readonly DeriveEntry[] = [];
    // Set when a (re)compile loaded a module with @derive methods; the first
    // dispatch afterward rebuilds every materialized view from its sources.
    private derivesDirty = false;
    private envelopeWindow: number | null = null;
    private readonly pendingDerives = new Set<number>();

    constructor(
        private readonly wasmPath: string,
        private readonly logging = true,
    ) {}

    /** Whether a compiled module is currently available to dispatch into. */
    get available(): boolean {
        return this.module !== null;
    }

    /**
     * (Re)compile when the wasm file appeared or changed since the last load.
     * Returns `true` when a (re)compile happened, `false` when the cached
     * module is still current or the file is missing (`available` tells the
     * caller which).
     */
    refresh(): boolean {
        let mtimeMs: number;
        try {
            mtimeMs = fs.statSync(this.wasmPath).mtimeMs;
        } catch {
            unregisterMaterializer(this.wasmPath);
            this.module = null;
            this.usesGoogleVerification = false;
            this.routeKinds = [];
            this.rpcKinds = [];
            this.derives = [];
            this.derivesDirty = false;
            this.loadedMtimeMs = -1;
            return false;
        }
        if (this.module !== null && mtimeMs === this.loadedMtimeMs) return false;

        const bytes = fs.readFileSync(this.wasmPath);
        this.envelopeWindow = envelopeWindowOf(bytes);
        const module = new WebAssembly.Module(bytes);
        this.assertImportSurface(module);
        this.assertExportSurface(module);
        // Refresh collection -> current schema_version so writes stamp the live layout;
        // after a @data type evolves + rebuild, old on-disk rows now look out of date.
        setDbCatalog(bytes);
        this.routeKinds = parseRouteKinds(bytes);
        this.rpcKinds = parseRpcKinds(bytes);
        this.derives = parseDerives(bytes);
        this.module = module;
        this.usesGoogleVerification = WebAssembly.Module.imports(module).some(
            entry => entry.module === 'env' && entry.name === 'google_verify',
        );
        this.loadedMtimeMs = mtimeMs;
        // Rebuild materialized views from their sources on the first dispatch
        // (after persistence is configured), so a freshly-loaded box serves
        // up-to-date views even after an out-of-band change to the source data.
        this.derivesDirty = this.derives.length > 0;
        registerMaterializer(this.wasmPath, (written) => {
            if (!fs.existsSync(this.wasmPath)) {
                unregisterMaterializer(this.wasmPath);
                return;
            }
            this.runAffectedDerives(written);
            persistDb();
        });
        return true;
    }

    /**
     * Run one request through a fresh guest instance. Throws on a guest trap
     * (including ToilScript `abort`), a malformed response envelope, or a
     * missing module; the caller shapes those into a 500.
     */
    dispatch(req: EnvelopeRequest): WasmDispatchResult {
        try {
            const context = this.prepareDispatch(req);
            const packed = context.exports.handle(context.reqOfs, context.length);
            return this.finishDispatch(context.exports, context.state, packed);
        } catch (error) {
            persistDb();
            throw error;
        }
    }

    /** Network preparation stays outside synchronous guest execution on Node >=24. */
    async dispatchWithNetwork(req: EnvelopeRequest): Promise<WasmDispatchResult> {
        if (this.usesGoogleVerification && req.method === 'POST' &&
            /^\/auth\/google\/login(?:\?|$)/.test(req.path) && devEnvGet('AUTH_GOOGLE_CLIENT_ID')) {
            try { await prepareGoogleKeys(); } catch { /* verifier fails closed */ }
        }
        return this.dispatch(req);
    }

    /** Development race harness: suspend before/after chosen DB imports while
     * another fresh request instance operates on the same shared store. */
    async dispatchAsync(
        req: EnvelopeRequest,
        hooks: DispatchInterleaving = {},
    ): Promise<WasmDispatchResult> {
        const jspi = WebAssembly as unknown as PromiseIntegration;
        if (typeof jspi.Suspending !== 'function' || typeof jspi.promising !== 'function')
            throw new Error(
                'dispatchAsync requires WebAssembly JSPI (Suspending/promising); use a Node release with JSPI enabled',
            );
        const context = this.prepareDispatch(req, (imports, ref, state) => {
            const env = imports.env;
            for (const [operation, value] of Object.entries(env)) {
                if (
                    !operation.startsWith('data.') ||
                    typeof value !== 'function' ||
                    [
                        'data.resolve_collection',
                        'data.take_result',
                        'data.budget',
                        'data.changes',
                        'data.begin_derive',
                        'data.end_derive',
                        'data.continue_derive',
                        'data.result_schema_version',
                        'data.write_allowed',
                        'data.job_allowed',
                    ].includes(operation)
                )
                    continue;
                const implementation = value as (...args: number[]) => number | bigint;
                env[operation] = new jspi.Suspending(async (...args: number[]) => {
                    const memory = ref.memory;
                    const [handle, ptr, len] = args;
                    const key =
                        memory !== null &&
                        ptr >= 0 &&
                        len >= 0 &&
                        len <= 4096 &&
                        ptr <= memory.buffer.byteLength &&
                        len <= memory.buffer.byteLength - ptr
                            ? new Uint8Array(memory.buffer, ptr, len).slice()
                            : null;
                    const point: DatabaseInterleavingPoint = {
                        request: req,
                        operation,
                        collection: state.db.handles[handle]?.name ?? null,
                        key,
                    };
                    await hooks.beforeDatabaseOperation?.(point);
                    const result = implementation(...args);
                    await hooks.afterDatabaseOperation?.({ ...point, result });
                    return result;
                });
            }
        });
        try {
            const packed = await jspi.promising(context.exports.handle)(
                context.reqOfs,
                context.length,
            );
            return this.finishDispatch(context.exports, context.state, packed);
        } catch (error) {
            persistDb();
            throw error;
        }
    }

    private prepareDispatch(
        req: EnvelopeRequest,
        wrap?: (
            imports: WebAssembly.Imports,
            ref: MemoryRef,
            state: ReturnType<typeof freshDispatchState>,
        ) => void,
    ) {
        if (this.module === null) throw new Error(`server wasm not loaded (${this.wasmPath})`);

        // First dispatch after a (re)load: materialize views from their sources
        // before serving the request, so reads see fresh views.
        this.rebuildDerivedViewsIfStale();

        const envelope = this.requestEnvelope(req);

        const ref: MemoryRef = { memory: null, logging: this.logging };
        const state = freshDispatchState();
        state.db.knownDerives = new Set(this.derives.map(deriveContinuationKey));
        state.clientIp = req.clientIp ?? '';
        // Match the edge DB gate: the HTTP method is the baseline authority, and `toildb.route_kinds`
        // can only tighten a mutating route to query. The reserved /__toil_rpc endpoint is the inverse -
        // a @remote defaults to read-only (Query); only an @action @remote (in rpc_kinds) may write.
        const rpcPath = req.path.split('?')[0] ?? req.path;
        const rpcMethod = req.method.toUpperCase();
        const rpcMutating =
            rpcMethod === 'POST' ||
            rpcMethod === 'PUT' ||
            rpcMethod === 'PATCH' ||
            rpcMethod === 'DELETE';
        if (rpcPath === '/__toil_rpc' && rpcMutating) {
            const idHeader = req.headers.find(([n]) => n.toLowerCase() === 'dacely-rpc')?.[1];
            // Strict u32 parse, mirroring the host's `v.parse::<u32>()`: reject trailing garbage/whitespace
            // and out-of-range ids so a malformed header falls through to read-only Query, exactly as prod.
            const id = idHeader !== undefined && /^\d+$/.test(idHeader) ? Number(idHeader) : NaN;
            state.db.functionKind =
                Number.isInteger(id) && id <= 0xffffffff
                    ? rpcKindForId(this.rpcKinds, id)
                    : DbFunctionKind.Query;
        } else {
            state.db.functionKind = dbFunctionKindForRequest(this.routeKinds, req.method, req.path);
        }
        const imports = buildHostImports(ref, state);
        if (wrap !== undefined) wrap(imports, ref, state);
        const instance = new WebAssembly.Instance(this.module, imports);
        const exports = instance.exports as unknown as HandleExports;
        ref.memory = exports.memory;

        const reqOfs = this.writeRequestEnvelope(exports.memory, envelope);

        return { exports, state, reqOfs, length: envelope.length };
    }

    private finishDispatch(
        exports: HandleExports,
        state: ReturnType<typeof freshDispatchState>,
        packed: bigint,
    ): WasmDispatchResult {
        const { ptr, len } = unpackHandleResult(packed);

        // Same bounds validation as the edge: never trust the guest's pointer.
        const memSize = exports.memory.buffer.byteLength;
        if (len > memSize || ptr + len > memSize)
            throw new Error(
                `guest returned an out-of-bounds response: ptr=${String(ptr)} len=${String(len)}`,
            );

        const resp = decodeResponseEnvelope(new Uint8Array(exports.memory.buffer, ptr, len));

        // Merge the imperative host-import state on top of the envelope (a
        // toiljs guest answers fully in-band, so this is usually a no-op).
        const headers: (readonly [string, string])[] = [...resp.headers, ...state.headers];
        const status = state.status ?? resp.status;

        const unhandled = headers.some(([n]) => n.toLowerCase() === UNHANDLED_HEADER);

        // Materialize: re-run any @derive whose @database had a source
        // collection written this request, under FunctionKind=Derive, so its
        // view.publish lands BEFORE the single persistDb() below flushes both the
        // request's writes and the derive's view to disk. A read writes nothing,
        // so this is a no-op for GETs.
        this.runAffectedDerives(state.db.writtenCollections, state.db);

        // Flush any DB writes this request made to disk, so dev data survives a
        // restart (and a crash never loses an already-served write).
        persistDb();

        return {
            status,
            headers: headers.filter(([n]) => n.toLowerCase() !== UNHANDLED_HEADER),
            body: resp.body,
            sendfile: state.sendfile,
            unhandled,
        };
    }

    /**
     * Run one request through the guest `render` entrypoint (edge SSR). Returns
     * the raw values-envelope bytes (status + template_hash + headers + slot
     * values) that the edge splices against the template manifest. Throws if
     * the module has no `render` export. Mirrors {@link dispatch}'s fresh-
     * instance + grow-and-write-envelope contract.
     */
    dispatchRender(req: EnvelopeRequest): Uint8Array {
        if (this.module === null) throw new Error(`server wasm not loaded (${this.wasmPath})`);

        this.rebuildDerivedViewsIfStale();
        const envelope = this.requestEnvelope(req);
        const ref: MemoryRef = { memory: null, logging: this.logging };
        const state = freshDispatchState();
        state.db.knownDerives = new Set(this.derives.map(deriveContinuationKey));
        state.clientIp = req.clientIp ?? '';
        state.db.functionKind = DbFunctionKind.Query;
        const instance = new WebAssembly.Instance(this.module, buildHostImports(ref, state));
        const exports = instance.exports as unknown as HandleExports & {
            render?: (reqOfs: number, reqLen: number) => bigint;
        };
        if (typeof exports.render !== 'function')
            throw new Error(`guest wasm has no 'render' export (${this.wasmPath})`);
        ref.memory = exports.memory;

        const reqOfs = this.writeRequestEnvelope(exports.memory, envelope);

        const packed = exports.render(reqOfs, envelope.length);
        const { ptr, len } = unpackHandleResult(packed);

        const memSize = exports.memory.buffer.byteLength;
        if (len > memSize || ptr + len > memSize)
            throw new Error(
                `guest returned out-of-bounds values: ptr=${String(ptr)} len=${String(len)}`,
            );
        // Copy out of the (about-to-be-dropped) instance's memory.
        return new Uint8Array(exports.memory.buffer, ptr, len).slice();
    }

    /**
     * After a mutating dispatch, re-run each `@derive` whose `@database` had a
     * source collection written, on a fresh instance under FunctionKind=Derive.
     * Each derive recomputes + `view.publish`es its materialized view (a later
     * Query route reads it via the non-scan `view.get`). A trapped derive is
     * logged and skipped: the request has already succeeded and the next write
     * re-derives, so a stale view is the worst case. Mirrors the edge runner,
     * which folds events into the view off the request path; in single-process
     * dev, running it synchronously-after-the-write is observably equivalent.
     */
    private runAffectedDerives(written: ReadonlySet<string>, source?: DbDevState): void {
        if (this.module === null) return;
        const retrying = new Set(this.pendingDerives);
        const affected = derivesForWrites(this.derives, written);
        for (const derive of affected) this.pendingDerives.add(derive.deriveId);
        for (const derive of this.derives.filter((d) => this.pendingDerives.has(d.deriveId))) {
            try {
                this.runDerive(
                    derive.deriveId,
                    source === undefined
                        ? fullRescanFrame()
                        : deriveChangesFrame(source, derive.dbName, retrying.has(derive.deriveId)),
                );
                this.pendingDerives.delete(derive.deriveId);
            } catch (err) {
                console.error(`[toil] derive ${derive.dbName}#${derive.methodName} failed:`, err);
            }
        }
    }

    /**
     * On the first dispatch after a (re)compile, rebuild every materialized view
     * from its sources (server start, hot-reload, or an out-of-band change to the
     * persisted source data). Runs once per load; ongoing writes are materialized
     * incrementally by {@link runAffectedDerives}. Mirrors the edge rebuilding a
     * view from its event log when a box first comes up.
     */
    private rebuildDerivedViewsIfStale(): void {
        this.runAffectedDerives(new Set());
        if (!this.derivesDirty) return;
        this.derivesDirty = false;
        for (const derive of this.derives) {
            try {
                this.runDerive(derive.deriveId);
            } catch (err) {
                console.error(
                    `[toil] derive ${derive.dbName}#${derive.methodName} failed on load:`,
                    err,
                );
            }
        }
    }

    /** One derive invocation: a fresh instance under Derive kind, calling the
     *  synthesized `derive_run(derive_id)` export (writes flow to the shared dev
     *  store via the `data.*` imports; the caller's persistDb() flushes them). */
    private runDerive(deriveId: number, changes = fullRescanFrame()): void {
        if (this.module === null) return;
        const ref: MemoryRef = { memory: null, logging: this.logging };
        const state = freshDispatchState();
        state.db.knownDerives = new Set(this.derives.map(deriveContinuationKey));
        state.db.functionKind = DbFunctionKind.Derive;
        state.db.deriveId = deriveId;
        state.db.deriveChanges = changes;
        const entry = this.derives.find((derive) => derive.deriveId === deriveId);
        if (entry === undefined) throw new Error('Unknown derive identity');
        state.db.deriveKey = deriveCheckpointKey(entry);
        const instance = new WebAssembly.Instance(this.module, buildHostImports(ref, state));
        const exports = instance.exports as unknown as DeriveExports;
        ref.memory = exports.memory;
        if (typeof exports.derive_run !== 'function') return;
        const rc = exports.derive_run(deriveId);
        if (rc !== 0n) throw new Error(`derive_run returned ${String(rc)}`);
        // Publish-then-persist: derive_run returned (its `view.publish`es landed synchronously in the dev
        // store), so commit the `events.since` cursor advances staged this run. A trapped fold throws above
        // and never reaches here, leaving the durable cursor for a re-read on the next trigger.
        commitDeriveCheckpoints(state.db);
    }

    private requestEnvelope(req: EnvelopeRequest): Uint8Array {
        const envelope = encodeRequestEnvelope(req);
        if (envelope.length > 8 * 1024 * 1024)
            throw new Error('request envelope exceeds the native 8 MiB request limit');
        return envelope;
    }

    private writeRequestEnvelope(memory: WebAssembly.Memory, envelope: Uint8Array): number {
        // Match the native host: use the reserved prefix when it fits, otherwise
        // deliver above the current heap. The toiljs entrypoint reserves that
        // tail before decoding so later allocations cannot overwrite the input.
        const fits = this.envelopeWindow === null || envelope.length <= this.envelopeWindow;
        const offset = fits ? 0 : memory.buffer.byteLength;
        const needed = offset + envelope.length;
        if (needed > memory.buffer.byteLength)
            memory.grow(Math.ceil((needed - memory.buffer.byteLength) / WASM_PAGE));
        Buffer.from(memory.buffer).set(envelope, offset);
        return offset;
    }

    /** Fail instantiation up front, with names, when the guest needs imports we do not provide. */
    private assertImportSurface(module: WebAssembly.Module): void {
        const missing = WebAssembly.Module.imports(module)
            .filter(
                (i) =>
                    i.kind === 'function' && (i.module !== 'env' || !PROVIDED_IMPORTS.has(i.name)),
            )
            .map((i) => `${i.module}.${i.name}`);
        if (missing.length > 0)
            throw new Error(
                `server wasm imports unsupported host functions: ${missing.join(', ')}`,
            );
    }

    /** The dispatcher needs the `handle` entrypoint and the exported linear memory. */
    private assertExportSurface(module: WebAssembly.Module): void {
        const names = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
        for (const required of ['handle', 'memory']) {
            if (!names.has(required))
                throw new Error(`server wasm does not export \`${required}\``);
        }
    }
}

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
    'abort',
    'set_status',
    'set_header',
    'respond_file',
    'thread_spawn',
    'Date.now',
    'client_ip',
    'ratelimit_check',
    'email_send',
    'env_get',
    'env_get_secure',
    // Per-domain analytics (see ./analytics/index.ts).
    'analytics_read',
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
    'crypto.mlkem_decapsulate',
    'crypto.voprf_evaluate',
    // ToilDB data API (see ./database.ts). Backed by ScyllaDB on the production
    // edge; backs the auth example's accounts + login challenges in dev.
    'data.resolve_collection',
    'data.get',
    'data.get_many',
    'data.exists',
    'data.create',
    'data.patch',
    'data.delete',
    'data.get_delete',
    'data.unique_lookup',
    'data.unique_claim',
    'data.unique_release',
    'data.view_get',
    'data.view_publish',
    'data.membership_contains',
    'data.membership_add',
    'data.membership_remove',
    'data.membership_list',
    'data.counter_get',
    'data.counter_add',
    'data.append',
    'data.append_once',
    'data.enqueue',
    'data.latest',
    'data.capacity_set_total',
    'data.capacity_available',
    'data.capacity_reserve',
    'data.capacity_confirm',
    'data.capacity_cancel',
    'data.take_result',
    'data.result_schema_version',
    'data.write_allowed',
]);

export class WasmServerModule {
    private module: WebAssembly.Module | null = null;
    private loadedMtimeMs = -1;
    private routeKinds: readonly RouteKindEntry[] = [];
    private rpcKinds: readonly RpcKindEntry[] = [];
    private derives: readonly DeriveEntry[] = [];
    // Set when a (re)compile loaded a module with @derive methods; the first
    // dispatch afterward rebuilds every materialized view from its sources.
    private derivesDirty = false;

    constructor(private readonly wasmPath: string) {}

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
            this.module = null;
            this.routeKinds = [];
            this.rpcKinds = [];
            this.derives = [];
            this.derivesDirty = false;
            this.loadedMtimeMs = -1;
            return false;
        }
        if (this.module !== null && mtimeMs === this.loadedMtimeMs) return false;

        const bytes = fs.readFileSync(this.wasmPath);
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
        this.loadedMtimeMs = mtimeMs;
        // Rebuild materialized views from their sources on the first dispatch
        // (after persistence is configured), so a freshly-loaded box serves
        // up-to-date views even after an out-of-band change to the source data.
        this.derivesDirty = this.derives.length > 0;
        return true;
    }

    /**
     * Run one request through a fresh guest instance. Throws on a guest trap
     * (including ToilScript `abort`), a malformed response envelope, or a
     * missing module; the caller shapes those into a 500.
     */
    dispatch(req: EnvelopeRequest): WasmDispatchResult {
        if (this.module === null) throw new Error(`server wasm not loaded (${this.wasmPath})`);

        // First dispatch after a (re)load: materialize views from their sources
        // before serving the request, so reads see fresh views.
        this.rebuildDerivedViewsIfStale();

        const envelope = encodeRequestEnvelope(req);

        const ref: MemoryRef = { memory: null };
        const state = freshDispatchState();
        state.clientIp = req.clientIp ?? '';
        // Match the edge DB gate: the HTTP method is the baseline authority, and `toildb.route_kinds`
        // can only tighten a mutating route to query. The reserved /__toil_rpc endpoint is the inverse -
        // a @remote defaults to read-only (Query); only an @action @remote (in rpc_kinds) may write.
        const rpcPath = req.path.split('?')[0] ?? req.path;
        const rpcMethod = req.method.toUpperCase();
        const rpcMutating =
            rpcMethod === 'POST' || rpcMethod === 'PUT' || rpcMethod === 'PATCH' || rpcMethod === 'DELETE';
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
        const instance = new WebAssembly.Instance(this.module, buildHostImports(ref, state));
        const exports = instance.exports as unknown as HandleExports;
        ref.memory = exports.memory;

        // The edge writes the envelope at offset 0, which only holds for tiny
        // requests: ToilScript static data starts at offset 1024, so anything
        // larger would corrupt the guest. `handle(req_ofs, req_len)` takes the
        // offset as a parameter, so we stay ABI-compatible and write past the
        // current end of linear memory instead (grown to fit). The guest heap
        // grows upward from its data section and copies the envelope into
        // managed objects on decode, well before it could reach this region.
        const reqOfs = exports.memory.buffer.byteLength;
        exports.memory.grow(Math.ceil(envelope.length / WASM_PAGE) || 1);
        Buffer.from(exports.memory.buffer).set(envelope, reqOfs);

        const packed = exports.handle(reqOfs, envelope.length);
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
        this.runAffectedDerives(state.db.writtenCollections);

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

        const envelope = encodeRequestEnvelope(req);
        const ref: MemoryRef = { memory: null };
        const state = freshDispatchState();
        state.clientIp = req.clientIp ?? '';
        state.db.functionKind = DbFunctionKind.Query;
        const instance = new WebAssembly.Instance(this.module, buildHostImports(ref, state));
        const exports = instance.exports as unknown as HandleExports & {
            render?: (reqOfs: number, reqLen: number) => bigint;
        };
        if (typeof exports.render !== 'function')
            throw new Error(`guest wasm has no 'render' export (${this.wasmPath})`);
        ref.memory = exports.memory;

        const reqOfs = exports.memory.buffer.byteLength;
        exports.memory.grow(Math.ceil(envelope.length / WASM_PAGE) || 1);
        Buffer.from(exports.memory.buffer).set(envelope, reqOfs);

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
    private runAffectedDerives(written: ReadonlySet<string>): void {
        if (this.module === null) return;
        for (const derive of derivesForWrites(this.derives, written)) {
            try {
                this.runDerive(derive.deriveId);
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
    private runDerive(deriveId: number): void {
        if (this.module === null) return;
        const ref: MemoryRef = { memory: null };
        const state = freshDispatchState();
        state.db.functionKind = DbFunctionKind.Derive;
        const instance = new WebAssembly.Instance(this.module, buildHostImports(ref, state));
        const exports = instance.exports as unknown as DeriveExports;
        ref.memory = exports.memory;
        if (typeof exports.derive_run !== 'function') return;
        exports.derive_run(deriveId);
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

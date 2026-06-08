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
    decodeResponseEnvelope,
    encodeRequestEnvelope,
    unpackHandleResult,
    type EnvelopeRequest,
} from './envelope.js';
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

/** Host functions the dev server provides under `env` (see `host.ts`). */
const PROVIDED_IMPORTS = new Set([
    'abort', 'set_status', 'set_header', 'respond_file', 'thread_spawn',
    // Web Crypto host functions (see ./crypto.ts).
    'crypto.fill_random', 'crypto.random_uuid', 'crypto.take_result', 'crypto.digest',
    'crypto.import_key', 'crypto.export_key', 'crypto.encrypt', 'crypto.decrypt',
    'crypto.sign', 'crypto.verify', 'crypto.derive_bits',
]);

export class WasmServerModule {
    private module: WebAssembly.Module | null = null;
    private loadedMtimeMs = -1;

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
            this.loadedMtimeMs = -1;
            return false;
        }
        if (this.module !== null && mtimeMs === this.loadedMtimeMs) return false;

        const bytes = fs.readFileSync(this.wasmPath);
        const module = new WebAssembly.Module(bytes);
        this.assertImportSurface(module);
        this.assertExportSurface(module);
        this.module = module;
        this.loadedMtimeMs = mtimeMs;
        return true;
    }

    /**
     * Run one request through a fresh guest instance. Throws on a guest trap
     * (including ToilScript `abort`), a malformed response envelope, or a
     * missing module; the caller shapes those into a 500.
     */
    dispatch(req: EnvelopeRequest): WasmDispatchResult {
        if (this.module === null) throw new Error(`server wasm not loaded (${this.wasmPath})`);

        const envelope = encodeRequestEnvelope(req);

        const ref: MemoryRef = { memory: null };
        const state = freshDispatchState();
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

        return {
            status,
            headers: headers.filter(([n]) => n.toLowerCase() !== UNHANDLED_HEADER),
            body: resp.body,
            sendfile: state.sendfile,
            unhandled,
        };
    }

    /** Fail instantiation up front, with names, when the guest needs imports we do not provide. */
    private assertImportSurface(module: WebAssembly.Module): void {
        const missing = WebAssembly.Module.imports(module)
            .filter((i) => i.kind === 'function' && (i.module !== 'env' || !PROVIDED_IMPORTS.has(i.name)))
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

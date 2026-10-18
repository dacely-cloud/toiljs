// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * The auto-populated RPC dispatcher. Every `@service` method and free `@remote`
 * function self-registers here at module init (compiler-injected), keyed by a
 * deterministic method id (FNV-1a of `"Service.method"` / `"fnName"` — the same
 * hash the generated client sends). The wasm `handle` export dispatches a
 * reserved `POST /__toil_rpc` (method id in the `dacely-rpc` header, `@data`-encoded
 * args in the body) to the matching method and returns its `@data`-encoded
 * result. Mirrors `Rest` (../rest/Rest.ts); calls are STATELESS — a fresh service
 * instance per call, exactly like a `@rest` controller.
 */
import { Request } from '../request';
import { Response } from '../response';
/** The reserved path a generated RPC client POSTs to. */
export declare const RPC_PATH: string;
/** The request header carrying the decimal `u32` method id. */
export declare const RPC_HEADER: string;
/** A registered RPC method: takes the encoded-args body and returns a `Response` - the encoded result
 *  (`Response.bytes`) on success, or a guard's `401`/`429` when the method carries `@auth`/`@ratelimit`.
 *  The compiler injects these (see toilscript injectService/injectRemote). */
export type RpcFn = (body: Uint8Array) => Response;
export declare class RpcRegistry {
    private ids;
    private fns;
    /** Compiler-injected: register one `@service` method / `@remote` function by id. Not for direct use. */
    register(id: u32, fn: RpcFn): void;
    /**
     * Dispatch a reserved `POST /__toil_rpc` call to its registered method. Returns `null` for ANY
     * non-RPC request (wrong method, wrong path, no id header) so the caller falls through to the
     * normal handler; returns a `400` for a well-formed RPC call whose id is unknown.
     */
    dispatch(req: Request): Response | null;
    /** Number of registered methods (diagnostics / tests). */
    get size(): i32;
}
/** The process-wide RPC dispatcher singleton. */
export declare const Rpc: RpcRegistry;

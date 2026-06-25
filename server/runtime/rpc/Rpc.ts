/**
 * The auto-populated RPC dispatcher. Every `@service` method and free `@remote`
 * function self-registers here at module init (compiler-injected), keyed by a
 * deterministic method id (FNV-1a of `"Service.method"` / `"fnName"` — the same
 * hash the generated client sends). The wasm `handle` export dispatches a
 * reserved `POST /__toil_rpc` (method id in the `toil-rpc` header, `@data`-encoded
 * args in the body) to the matching method and returns its `@data`-encoded
 * result. Mirrors `Rest` (../rest/Rest.ts); calls are STATELESS — a fresh service
 * instance per call, exactly like a `@rest` controller.
 */

import { Method, Request } from '../request';
import { Response } from '../response';

/** The reserved path a generated RPC client POSTs to. */
export const RPC_PATH: string = '/__toil_rpc';
/** The request header carrying the decimal `u32` method id. */
export const RPC_HEADER: string = 'toil-rpc';

/** A registered RPC method: takes the encoded-args body, returns the encoded result. */
export type RpcFn = (body: Uint8Array) => Uint8Array;

export class RpcRegistry {
    private ids: Array<u32> = new Array<u32>();
    private fns: Array<RpcFn> = new Array<RpcFn>();

    /** Compiler-injected: register one `@service` method / `@remote` function by id. Not for direct use. */
    register(id: u32, fn: RpcFn): void {
        this.ids.push(id);
        this.fns.push(fn);
    }

    /**
     * Dispatch a reserved `POST /__toil_rpc` call to its registered method. Returns `null` for ANY
     * non-RPC request (wrong method, wrong path, no id header) so the caller falls through to the
     * normal handler; returns a `400` for a well-formed RPC call whose id is unknown.
     */
    dispatch(req: Request): Response | null {
        if (req.method != Method.POST) return null;
        let path = req.path;
        const q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        if (path != RPC_PATH) return null;
        const raw = req.header(RPC_HEADER);
        if (raw == null) return null;
        const id = U32.parseInt(raw, 10);
        for (let i = 0, n = this.ids.length; i < n; i++) {
            if (this.ids[i] == id) {
                return Response.bytes(this.fns[i](req.body));
            }
        }
        return Response.badRequest('unknown rpc method');
    }

    /** Number of registered methods (diagnostics / tests). */
    get size(): i32 {
        return this.ids.length;
    }
}

/** The process-wide RPC dispatcher singleton. */
export const Rpc: RpcRegistry = new RpcRegistry();

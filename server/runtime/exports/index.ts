/**
 * Wasm exports the edge calls.
 *
 * The user's `main.ts` does
 *
 * ```ts
 * export * from './runtime/exports';
 * ```
 *
 * to surface `handle(i32, i32) -> i64` (and any future entry points)
 * as wasm exports. The actual work — decode the envelope, run the
 * user's handler via `Server.currentHandler()`, encode the response —
 * lives here.
 */

import { Server } from '../env/Server';
import { decodeRequest, encodeResponse } from '../envelope';
import { Response } from '../response';

@main
export function handle(req_ofs: i32, req_len: i32): i64 {
    let resp: Response;

    const req = decodeRequest(<usize>req_ofs, <usize>req_len);
    if (req == null) {
        // Truncated or malformed envelope — host shouldn't send these
        // but produce a clean 400 so the dispatcher doesn't see a
        // garbage return value.
        resp = Response.badRequest('malformed request envelope');
    } else {
        const handler = Server.currentHandler();
        handler.onRequestStarted(req);
        resp = handler.handle(req);
        handler.onRequestCompleted(req, resp);
    }

    // Lay out the response envelope IMMEDIATELY AFTER the live heap, not at a
    // fixed high page. The host resets linear memory between requests by
    // restoring only the contiguous region the tenant actually touched; parking
    // the response at a fixed 64 KiB (when the heap reaches only ~12 KiB) forced
    // the reset to zero the whole ~52 KiB gap every request — the dominant write
    // bandwidth at scale. `heap.alloc` hands back the slot just past the bump
    // pointer, so request + static + heap + response form ONE contiguous span
    // and the soft guard tightens to it automatically. Encode runs AFTER decode,
    // so it can never clobber the request; the max() keeps it clear of an
    // oversized request envelope regardless.
    let bound: usize = 512 + <usize>resp.body.length;
    for (let i = 0, n = resp.headers.length; i < n; i++) {
        const h = resp.headers[i];
        bound +=
            <usize>String.UTF8.byteLength(h.name) + <usize>String.UTF8.byteLength(h.value) + 8;
    }
    let dst = <usize>heap.alloc(bound);
    const req_end = <usize>req_ofs + <usize>req_len;
    if (dst < req_end) dst = req_end;

    const total = encodeResponse(resp, dst);
    Server.resetCurrentHandler();
    return ((<i64>dst) << 32) | (<i64>total);
}

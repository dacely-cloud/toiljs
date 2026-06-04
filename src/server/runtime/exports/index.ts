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

/**
 * Linear-memory offset where we lay out the response envelope.
 *
 * The host writes the request envelope starting at offset 0. We pick
 * `65536` (one wasm page in) so the response never overlaps with the
 * request, no matter how big the request grew. The edge's
 * LimitingTunables caps the linear memory at 1024 pages (64 MiB), so
 * we still have 63 MiB of room past `RESPONSE_BASE` for the response
 * envelope.
 */
const RESPONSE_BASE: usize = 65536;

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

    const total = encodeResponse(resp, RESPONSE_BASE);
    Server.resetCurrentHandler();
    return ((<i64>RESPONSE_BASE) << 32) | (<i64>total);
}

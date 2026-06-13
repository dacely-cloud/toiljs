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

// Ensure the cookie library is in every build so its `@global` types
// (`Cookie`, `Cookies`, `SecureCookies`, ...) register as ambient globals,
// usable in a handler with no import, even for a `main.ts` that imports only
// `exports`.
import '../http/cookie';
import '../http/cookies';
import '../http/securecookies';

// Surface the edge-SSR `render(i32, i32) -> i64` export. Optional at the host:
// a build with no SSR routes still exports `render`, but its `Ssr` registry is
// empty so every call returns the fail-safe empty result. The compiler injects
// the route-render registrations (and their imports) into the user's main.ts.
export { render } from './render';

@main
export function handle(req_ofs: i32, req_len: i32): i64 {
    let resp: Response;

    // TAIL DELIVERY: a request too large for the low envelope window is
    // parked by the edge in grown pages ABOVE the heap and arrives with
    // `req_ofs != 0`. Advance the bump allocator past its end before
    // decoding, so no decode-time allocation (body copy, strings) can
    // land inside the envelope while it is still being read. The edge
    // retires this instance after the response, so the burned span is
    // never paid again.
    if (req_ofs != 0) {
        heap.alloc(<usize>req_ofs + <usize>req_len);
    }

    const req = decodeRequest(<usize>req_ofs, <usize>req_len);
    if (req == null) {
        // Truncated or malformed envelope — host shouldn't send these
        // but produce a clean 400 so the dispatcher doesn't see a
        // garbage return value.
        resp = Response.badRequest('malformed request envelope');
    } else {
        // Publish the request ambiently so AuthService.getUser()/hasSession()
        // can read its cookies with no argument. Cleared in resetCurrentHandler.
        Server.currentRequest = req;
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

/**
 * The `render(i32, i32) -> i64` wasm export: the edge-SSR entrypoint.
 *
 * Mirrors `handle` (see `./index.ts`) but returns a **values envelope** (the
 * hole values) instead of a full HTTP response. The host has the precompiled
 * template mmap'd and splices these values into it, so `render` does NO page
 * rendering: it runs the matched route's generated stamping and serialises a
 * compact list of `(slot_id, kind, bytes)`.
 *
 * The user's `main.ts` surfaces this by re-exporting `./runtime/exports`. A
 * module with no SSR routes simply registers nothing; the host treats a
 * missing `render` export as "no template routes".
 */

import { decodeRequest } from '../envelope';
import { Server } from '../env/Server';
import { encodeValues, valuesEncodedBound } from '../ssr/encode';
import { Ssr } from '../ssr/Ssr';
import { SlotValues, zeroHash } from '../ssr/slots';

export function render(req_ofs: i32, req_len: i32): i64 {
    // TAIL DELIVERY: same contract as `handle` — a large request parked above
    // the heap arrives with req_ofs != 0; advance past it before decoding so no
    // allocation lands inside the still-being-read envelope.
    if (req_ofs != 0) {
        heap.alloc(<usize>req_ofs + <usize>req_len);
    }

    let values: SlotValues;
    const req = decodeRequest(<usize>req_ofs, <usize>req_len);
    if (req == null) {
        // Malformed envelope: emit a fail-safe empty result (zero hash -> the
        // host rejects it as a coherence mismatch -> 500), never a broken page.
        values = new SlotValues(zeroHash()).setStatus(400);
    } else {
        Server.currentRequest = req;
        const hit = Ssr.dispatch(req);
        // No matching route render is a guest/host coherence problem; fail safe.
        values = hit != null ? hit : new SlotValues(zeroHash()).setStatus(500);
    }

    // Lay out the values envelope immediately past the live heap, exactly like
    // `handle`, so the host's contiguous-region reset stays tight.
    const dst0 = <usize>heap.alloc(valuesEncodedBound(values) + 8);
    const req_end = <usize>req_ofs + <usize>req_len;
    const dst = dst0 < req_end ? req_end : dst0;

    const total = encodeValues(values, dst);
    Server.resetCurrentHandler();
    return ((<i64>dst) << 32) | (<i64>total);
}

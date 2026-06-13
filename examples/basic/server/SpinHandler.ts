import { Request, Response, ToilHandler } from 'toiljs/server/runtime';

// Module-level counter so the loop body has an observable side effect the
// optimizer cannot remove (and even a bare loop would still be gas-metered).
let counter: i64 = 0;

export class SpinHandler extends ToilHandler {
    public handle(req: Request): Response {
        // Infinite CPU burn on EVERY request. The edge's per-request gas
        // budget (MAX_GAS_WASM_INIT) must trap this and 502 instead of
        // freezing the worker.
        while (true) {
            counter = counter + 1;
        }
        // unreachable
        return Response.text('unreachable\n');
    }
}

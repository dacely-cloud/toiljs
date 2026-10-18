// Generated from server/runtime by scripts/gen-server-types.mjs.
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
export declare function render(req_ofs: i32, req_len: i32): i64;

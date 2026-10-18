// Generated from server/runtime by scripts/gen-server-types.mjs.
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
import '../http/cookie';
import '../http/cookies';
import '../http/securecookies';
export { render } from './render';
export declare function handle(req_ofs: i32, req_len: i32): i64;

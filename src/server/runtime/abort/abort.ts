/**
 * AssemblyScript runtime panic hook.
 *
 * Any unhandled `assert()`, out-of-bounds array access, or other
 * runtime failure in the compiled wasm reaches the host's `env::abort`
 * import (see toil-backend's `AbortImport`). For that import to be
 * satisfied at link time the compiled module needs an exported
 * `abort` function with the AS-standard signature; the user's
 * `main.ts` re-exports it as:
 *
 * ```ts
 * export function abort(message: string, fileName: string, line: u32, column: u32): void {
 *     revertOnError(message, fileName, line, column);
 * }
 * ```
 *
 * We just call `unreachable()` after recording the location: wasmer
 * traps the call, the edge's pump catches the trap, marks the
 * instance poisoned, and returns 502 to the client. The location
 * fields are deliberately left untouched in case a future host
 * import wants to read them off the message/fileName strings; today
 * the edge's `AbortImport::execute` only logs `line`/`column`.
 */

export function revertOnError(
    _message: string,
    _fileName: string,
    _line: u32,
    _column: u32,
): void {
    unreachable();
}

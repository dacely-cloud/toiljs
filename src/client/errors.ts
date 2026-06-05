/**
 * Extracts a human-readable message from an unknown thrown value. Handy in `catch`
 * blocks where the caught value is typed `unknown`. Exposed as a global `parseError`
 * (no import) alongside the other toiljs globals.
 *
 * @param err - the caught value (an `Error`, a string, or anything else).
 * @returns the `Error.message` when `err` is an `Error`, otherwise `String(err)`.
 */
export function parseError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

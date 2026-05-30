/**
 * AssemblyScript backend entry, compiled by the `toilscript` fork via `asc`.
 *
 * Placeholder module: a trivial exported function that compiles with the stock fork std.
 * Custom native instructions/decorators (e.g. `@main`) ship from the `toilscript`
 * fork directly — no transformer required.
 */

export function add(a: i32, b: i32): i32 {
    return a + b;
}

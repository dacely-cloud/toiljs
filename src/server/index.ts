/**
 * toilscript server (WASM) entry, compiled to WebAssembly by `toilscript`.
 *
 * Placeholder module: a trivial exported function that compiles with the toilscript std.
 * Native decorators (e.g. `@main`) ship from toilscript directly, no transformer required.
 */

export function add(a: i32, b: i32): i32 {
    return a + b;
}

/**
 * Server (WASM) entry point, compiled by the toilscript fork (`toilscript --target release`).
 *
 * `@main` is a toilscript-native decorator — no import needed. It marks this
 * function as the module entry; the compiler exports it as the WebAssembly
 * export `main`.
 */
import { add } from './index';

@main
function run(): i32 {
    return add(40, 2);
}

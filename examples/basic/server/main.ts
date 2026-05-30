import { add } from './index';

// `@main` is a toilscript-native decorator: it marks the WASM module entry point,
// exported as the `main` function. No import needed.
@main
function run(): i32 {
    return add(40, 2);
}

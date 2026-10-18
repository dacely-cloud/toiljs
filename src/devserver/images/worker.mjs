// Execute the same bounded Rust codec as the native host, inside WASI memory.
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
try {
    const module = await WebAssembly.compile(
        readFileSync(new URL('../../../assets/image-codec.wasm', import.meta.url)),
    );
    const wasi = new WASI({
        version: 'preview1',
        args: [],
        env: {},
        preopens: {},
        returnOnExit: true,
    });
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    const code = wasi.start(instance);
    if (code !== 0) {
        const error = Buffer.alloc(4);
        error.writeInt32LE(-4);
        process.stdout.write(error);
    }
} catch (error) {
    const status = Buffer.alloc(4);
    status.writeInt32LE(error instanceof WebAssembly.RuntimeError ? -4 : -7);
    process.stdout.write(status);
}

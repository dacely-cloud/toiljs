/**
 * The host import surface the dev server exposes to the guest, mirroring the
 * functions the production edge (`toil-backend/src/wasm/host/imports.rs`)
 * registers under the `env` namespace:
 *
 *   - `abort(msg, file, line, col)`   ToilScript panic hook; raises a trap
 *   - `set_status(code)`              imperative status (clamped to [100, 599])
 *   - `set_header(nPtr, nLen, vPtr, vLen)`  imperative response header
 *   - `respond_file(pathPtr, pathLen)`      stream a file as the response body
 *   - `thread_spawn(startArg)`        fail-closed stub, always -1 (no threading in dev)
 *
 * The ToilScript runtime returns status + headers in-band via the response
 * envelope, so a toiljs guest today only imports `abort`; the imperative
 * functions are provided for parity with the edge and apply on top of the
 * envelope (a `set_status` wins over the envelope status, `set_header` values
 * are appended). Extra keys in the import object are ignored by
 * `WebAssembly.Instance`, so offering the full surface costs nothing.
 */

/** Limits identical to the edge's `set_header` / `respond_file` bounds. */
const MAX_TOTAL_HEADERS_BYTES = 64 * 1024;
const MAX_HEADER_NAME_LEN = 256;
const MAX_HEADER_VALUE_LEN = 8192;
const MAX_PATH_LEN = 4096;

/** RFC 9110 tchar token, the only bytes allowed in a header name. */
const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** A guest `abort()` (ToilScript assert/bounds-check failure), surfaced as a trap. */
export class WasmAbortError extends Error {
    constructor(message: string, fileName: string, line: number, column: number) {
        super(
            `wasm aborted: ${message || '<no message>'}` +
                (fileName ? ` at ${fileName}:${String(line)}:${String(column)}` : ''),
        );
        this.name = 'WasmAbortError';
    }
}

/** Per-dispatch state the imperative host imports write into. */
export interface DispatchState {
    /** Status from `set_status`, or `null` when the guest never called it. */
    status: number | null;
    /** Headers accumulated by `set_header`, in call order. */
    headers: [string, string][];
    /** Total header bytes so far (cap: {@link MAX_TOTAL_HEADERS_BYTES}). */
    headerBytes: number;
    /** File path from `respond_file`, or `null`; when set, the envelope body is ignored. */
    sendfile: string | null;
}

/** A fresh, zeroed per-dispatch state (the edge resets the same way before each request). */
export function freshDispatchState(): DispatchState {
    return { status: null, headers: [], headerBytes: 0, sendfile: null };
}

/**
 * Late-bound memory holder: the import object must exist before the instance
 * (and therefore its exported memory) does, so the host functions read through
 * this indirection. The module loader fills it in right after instantiation.
 */
export interface MemoryRef {
    memory: WebAssembly.Memory | null;
}

function mem(ref: MemoryRef): Buffer {
    if (!ref.memory) throw new Error('host import called before memory was bound');
    return Buffer.from(ref.memory.buffer);
}

/** Bounds-checked byte read out of guest linear memory. */
function readBytes(ref: MemoryRef, ptr: number, len: number): Buffer {
    const m = mem(ref);
    if (ptr < 0 || len < 0 || ptr + len > m.length)
        throw new Error(`host import read out of bounds: ptr=${String(ptr)} len=${String(len)}`);
    return m.subarray(ptr, ptr + len);
}

/**
 * Read a ToilScript string (UTF-16LE payload, byte length in the u32 at
 * `ptr - 4`). Used by `abort`, whose pointers reference string objects rather
 * than raw byte ranges. A null pointer yields ''.
 */
function readGuestString(ref: MemoryRef, ptr: number): string {
    if (ptr === 0) return '';
    const m = mem(ref);
    if (ptr < 4 || ptr > m.length) return '';
    const byteLen = m.readUInt32LE(ptr - 4);
    if (ptr + byteLen > m.length) return '';
    return m.toString('utf16le', ptr, ptr + byteLen);
}

/**
 * Build the `env` import object for one instance. `state` collects what the
 * imperative imports produce during a dispatch; bind a fresh state per request.
 */
export function buildHostImports(ref: MemoryRef, state: DispatchState): WebAssembly.Imports {
    return {
        env: {
            abort: (msgPtr: number, filePtr: number, line: number, col: number): void => {
                throw new WasmAbortError(
                    readGuestString(ref, msgPtr),
                    readGuestString(ref, filePtr),
                    line,
                    col,
                );
            },

            set_status: (code: number): void => {
                state.status = code >= 100 && code <= 599 ? code : 500;
            },

            set_header: (namePtr: number, nameLen: number, valPtr: number, valLen: number): void => {
                if (nameLen > MAX_HEADER_NAME_LEN)
                    throw new Error(`header name too long: ${String(nameLen)} bytes`);
                if (valLen > MAX_HEADER_VALUE_LEN)
                    throw new Error(`header value too long: ${String(valLen)} bytes`);
                if (state.headerBytes + nameLen + valLen > MAX_TOTAL_HEADERS_BYTES)
                    throw new Error('total response headers exceed 64 KiB');
                const name = readBytes(ref, namePtr, nameLen).toString('utf8');
                const value = readBytes(ref, valPtr, valLen).toString('utf8');
                if (!TCHAR.test(name)) throw new Error(`invalid header name: ${name}`);
                if (/[\r\n]/.test(value)) throw new Error('header value contains CR/LF');
                state.headers.push([name, value]);
                state.headerBytes += nameLen + valLen;
            },

            respond_file: (pathPtr: number, pathLen: number): void => {
                if (pathLen > MAX_PATH_LEN)
                    throw new Error(`respond_file path too long: ${String(pathLen)} bytes`);
                state.sendfile = readBytes(ref, pathPtr, pathLen).toString('utf8');
            },

            thread_spawn: (_startArg: number): number => -1,
        },
    };
}

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

import { buildCryptoImports, freshCryptoState, type CryptoState } from './crypto.js';
import { devEnvGet, devEnvGetSecure } from './env.js';
import { ratelimitCheck } from './ratelimit.js';

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
    /** The connecting client's IP for `client_ip` (the edge uses the socket peer);
     *  set per dispatch from the Node request's `socket.remoteAddress`, '' if unknown. */
    clientIp: string;
    /** Per-dispatch Web Crypto keystore + result scratch (mirrors the edge). */
    crypto: CryptoState;
}

/** A fresh, zeroed per-dispatch state (the edge resets the same way before each request). */
export function freshDispatchState(): DispatchState {
    return {
        status: null,
        headers: [],
        headerBytes: 0,
        sendfile: null,
        clientIp: '',
        crypto: freshCryptoState(),
    };
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
 * Resolve one `Environment.get`/`getSecure` lookup against the dev env source
 * and write it into the guest buffer, with the edge's return protocol: the value
 * byte length (`0` = present-but-empty), `-1` if `outCap` is too small (the guest
 * retries with a bigger buffer), `-2` if the key is absent.
 */
function envLookup(
    ref: MemoryRef,
    keyPtr: number,
    keyLen: number,
    outPtr: number,
    outCap: number,
    secure: boolean,
): number {
    const key = readBytes(ref, keyPtr, keyLen).toString('utf8');
    const val = secure ? devEnvGetSecure(key) : devEnvGet(key);
    if (val === null) return -2; // ABSENT
    const bytes = Buffer.from(val, 'utf8');
    if (bytes.length > outCap) return -1; // TOO_SMALL
    const m = mem(ref);
    if (outPtr < 0 || outPtr + bytes.length > m.length)
        throw new Error('env_get write out of bounds');
    bytes.copy(m, outPtr);
    return bytes.length;
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

            // Write the client's IP (set per dispatch from the connection's
            // remote address) into the guest buffer. Returns the byte length,
            // 0 if unknown, -1 if the buffer is too small. Mirrors the edge's
            // `client_ip_import.rs`.
            client_ip: (outPtr: number, cap: number): number => {
                const ip = state.clientIp;
                if (ip.length === 0) return 0;
                const bytes = Buffer.from(ip, 'utf8');
                if (bytes.length > cap) return -1;
                const m = mem(ref);
                if (outPtr < 0 || outPtr + bytes.length > m.length)
                    throw new Error('client_ip write out of bounds');
                bytes.copy(m, outPtr);
                return bytes.length;
            },

            // `@ratelimit` decorator hook. Accounts one event for this request
            // against the dev limiter, keyed on the explicit guest key when
            // given (`keyLen > 0`), else the client IP. Returns the remaining
            // budget (>= 0, allowed) or a negative `Retry-After` in seconds
            // (denied). Mirrors the edge's `ratelimit_check_import.rs`.
            ratelimit_check: (
                routeId: number,
                strategy: number,
                limit: number,
                window: number,
                keyPtr: number,
                keyLen: number,
            ): number => {
                const identity =
                    keyLen > 0
                        ? readBytes(ref, keyPtr, keyLen).toString('utf8')
                        : state.clientIp || '0';
                const d = ratelimitCheck(routeId, strategy, limit, window, identity, Date.now());
                return d.allowed ? 1 : -Math.max(1, d.retryAfterSecs);
            },

            // `env::email_send`: the dev server has no email provider, so it
            // parses the recipient for a log line and reports Sent (0), the same
            // i32 contract the edge returns. The suspension is a host-side concern
            // on the edge (call_async); the wasm just sees an i32 either way.
            email_send: (reqPtr: number, reqLen: number): number => {
                // Header: u16 to_len | u16 subj_len | u16 purpose_len | u32 body_len
                // | u32 html_len (14 bytes), then payloads; `to` is first.
                const raw = readBytes(ref, reqPtr, reqLen);
                let to = '<unparsed>';
                if (raw.length >= 14) {
                    const toLen = raw.readUInt16LE(0);
                    if (14 + toLen <= raw.length) to = raw.toString('utf8', 14, 14 + toLen);
                }
                process.stdout.write(`  ✉ dev email_send -> ${to} (not actually sent)\n`);
                return 0; // EmailStatus.Sent
            },

            // `Environment.get` / `getSecure`: copy one tenant env value into the
            // guest buffer. Returns the byte length (0 = present-but-empty), -1 if
            // the buffer is too small (the guest retries bigger), -2 if absent.
            // Disjoint buckets: `env_get` reads vars, `env_get_secure` reads
            // secrets. Mirrors the edge's `env_get_import.rs`; the dev source is
            // `.env` (+ process.env vars) and `.env.secrets` (see ./env.ts).
            env_get: (keyPtr: number, keyLen: number, outPtr: number, outCap: number): number =>
                envLookup(ref, keyPtr, keyLen, outPtr, outCap, false),
            env_get_secure: (
                keyPtr: number,
                keyLen: number,
                outPtr: number,
                outCap: number,
            ): number => envLookup(ref, keyPtr, keyLen, outPtr, outCap, true),

            thread_spawn: (_startArg: number): number => -1,

            // `Date.now()` -> wall-clock milliseconds, matching the edge host.
            // The guest divides by 1000 for Unix seconds (sessions, challenges).
            'Date.now': (): number => Date.now(),

            // Web Crypto host functions (`env.crypto.*`), backed by Node's
            // `crypto`. The dev server skips metering, so these charge nothing.
            ...buildCryptoImports(ref, state.crypto),
        },
    };
}

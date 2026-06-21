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

import { devEnvGet, devEnvGetSecure } from '../config/env.js';
import { ratelimitCheck } from '../config/ratelimit.js';
import { buildDatabaseImports, type DbDevState, freshDbState } from '../db/index.js';
import { EmailStatus, getEmailService } from '../email/index.js';
import { parseEmailBlob } from '../email/wire.js';
import { buildCryptoImports, type CryptoState, freshCryptoState } from './crypto.js';

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
    /** Per-dispatch ToilDB state: resolved collection handles + result stash. */
    db: DbDevState;
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
        db: freshDbState(),
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
 * Framework auth secrets that, when unset, SILENTLY fall back to a published,
 * well-known dev default inside the guest (see `server/globals/auth.ts`). Reading
 * one that is absent means the wasm is about to sign sessions / derive keys under
 * a value anyone can read off npm, so we surface it. Harmless for local dev; a
 * deployed node MUST set these out of band (`.env.secrets` / the dashboard).
 */
const INSECURE_DEFAULT_SECRETS: Record<string, string> = {
    AUTH_SESSION_SECRET:
        'session cookies will be signed with a PUBLISHED key, so anyone can forge one and skip login',
    AUTH_OPRF_SEED: 'the password OPRF seed will be the published dev value',
    AUTH_KEM_SK: 'the server ML-KEM secret key will be the published dev value',
};

/** Warned-once set, keyed by secret name, so a hot path cannot spam the log. */
const warnedInsecureSecrets = new Set<string>();

/** Warn (once per process) that an absent framework secret falls back to a public default. */
function warnInsecureSecretFallback(key: string): void {
    if (warnedInsecureSecrets.has(key)) return;
    warnedInsecureSecrets.add(key);
    process.stdout.write(
        `  ⚠ ${key} is not set: ${INSECURE_DEFAULT_SECRETS[key]}. ` +
            `Fine for local dev, but a deployed node MUST set it in .env.secrets (or on your deploy target). ` +
            `Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\n`,
    );
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
    if (val === null) {
        if (secure && key in INSECURE_DEFAULT_SECRETS) warnInsecureSecretFallback(key);
        return -2; // ABSENT
    }
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

            set_header: (
                namePtr: number,
                nameLen: number,
                valPtr: number,
                valLen: number,
            ): void => {
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

            // `env::email_send`: the FULL email pipeline in dev (./email): parse +
            // recipient validation + dedup + per-min/day budget + per-recipient cap
            // run SYNCHRONOUSLY (exact status — BadRecipient/Deduped/Budget/
            // RecipientCapped), then the real provider send is FIRE-AND-FORGET (a
            // sync wasm import can't await it), so the guest gets Sent optimistically
            // and the true outcome is logged. Unconfigured email stays a log-only
            // mock returning Sent. Mirrors the edge's `email_send_import.rs`.
            email_send: (reqPtr: number, reqLen: number): number => {
                const raw = readBytes(ref, reqPtr, reqLen);
                const svc = getEmailService();
                if (svc === null) {
                    const to = parseEmailBlob(raw)?.to ?? '<unparsed>';
                    process.stdout.write(
                        `  ✉ dev email_send -> ${to} (no email config; not sent)\n`,
                    );
                    return EmailStatus.Sent;
                }
                const { status, parsed } = svc.prepare(raw);
                if (parsed === null) {
                    process.stdout.write(`  ✉ dev email_send -> ${EmailStatus[status]}\n`);
                    return status;
                }
                void svc
                    .deliver(parsed)
                    .then((s) => {
                        const label = s === EmailStatus.Sent ? 'sent' : EmailStatus[s];
                        process.stdout.write(`  ✉ dev email_send -> ${parsed.to} (${label})\n`);
                    })
                    .catch((e: unknown) => {
                        process.stdout.write(
                            `  ✉ dev email_send -> ${parsed.to} (error: ${String(e)})\n`,
                        );
                    });
                return EmailStatus.Sent; // optimistic; sync wasm can't await the send
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
            'Date.now': (): bigint => BigInt(Date.now()),

            // Web Crypto host functions (`env.crypto.*`), backed by Node's
            // `crypto`. The dev server skips metering, so these charge nothing.
            ...buildCryptoImports(ref, state.crypto),

            // `env::data.*`: the ToilDB data API, emulated in process (see
            // ./database.ts). Backs the auth example's accounts + login
            // challenges so register/login spans requests under `toiljs dev`;
            // the production edge backs the SAME imports with ScyllaDB.
            ...buildDatabaseImports(ref, state.db),
        },
    };
}

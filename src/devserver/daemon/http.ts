/**
 * Dev-server daemon outbound HTTP (`daemon.http_call`).
 *
 * The request/response envelope below is the same little-endian framing the
 * native edge host speaks (see `toil-backend/src/wasm/cold/imports.rs`), so the
 * codec here is shared by both transports and only the act of "getting a
 * response" differs.
 *
 * Two transports, selected by `TOIL_DEV_DAEMON_HTTP`:
 *   - `mock` (default): resolve the request against an installed
 *     {@link DaemonHttpMock}. Unchanged from previous releases, and still the
 *     value when the variable is unset, empty, or anything not listed below, so
 *     a stray value can never start making real network calls.
 *   - `real`: perform an actual outbound HTTP request. Selected by
 *     `real`, `1`, `true`, or `on` (case- and whitespace-insensitive).
 *
 * `http_call` is a synchronous wasm import, and Node has no synchronous HTTP
 * client, so the real transport runs one short-lived child process per call and
 * blocks on it. That is deliberate: this is a dev-only path, and correctness of
 * the blocking contract matters more than the per-call process cost.
 *
 * Deviations from the edge host, both intentional:
 *   - No SSRF private-address block. Calling a local service (a Stripe CLI
 *     listener, a fixture server) is the whole point of real mode here; the
 *     native host needs an explicit test hook to allow loopback, so emulating
 *     that guard in dev would only break the use case.
 *   - Redirects are not followed, matching the edge host's
 *     `redirect::Policy::none()`: a 3xx is surfaced to the daemon as-is.
 */
import { spawnSync } from 'node:child_process';
import type { MemoryRef } from '../runtime/host.js';

export interface DaemonHttpRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: Uint8Array;
}
export interface DaemonHttpResponse {
    readonly status: number;
    readonly headers?: readonly (readonly [string, string])[];
    readonly body?: Uint8Array;
}
/** Synchronous deterministic transport seam. No network request is made by the emulator. */
export type DaemonHttpMock = (request: DaemonHttpRequest) => DaemonHttpResponse | null;
const FAILED = -BigInt(0x10000 + 0x0405);
const TOO_SMALL = -1n;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MAX_METHOD_BYTES = 16;
const MAX_FIELD_BYTES = 8192;
const MAX_HEADER_COUNT = 64;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const CHILD_SLACK_MS = 2_000;
const CHILD_MAX_BUFFER = 8 * 1024 * 1024;
/** Name of the environment variable that selects the daemon HTTP transport. */
export const DAEMON_HTTP_ENV = 'TOIL_DEV_DAEMON_HTTP';
/** Values of {@link DAEMON_HTTP_ENV} that select the real transport. */
const REAL_VALUES = new Set(['real', '1', 'true', 'on']);
/**
 * Resolve the configured daemon HTTP transport from an environment object.
 *
 * @param env Environment to read; defaults to `process.env`.
 * @returns `'real'` only for an explicit opt-in, otherwise `'mock'`.
 */
export function daemonHttpMode(env = process.env) {
    const raw = env?.[DAEMON_HTTP_ENV];
    if (typeof raw !== 'string')
        return 'mock';
    return REAL_VALUES.has(raw.trim().toLowerCase()) ? 'real' : 'mock';
}
/** Real-mode request timeout, overridable via `TOIL_DEV_DAEMON_HTTP_TIMEOUT_MS`. */
function realTimeoutMs(env = process.env) {
    const raw = env?.[DAEMON_HTTP_ENV + '_TIMEOUT_MS'];
    const parsed = typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}
/**
 * Validate the host-supplied memory window and return a writable view of it.
 *
 * Bounds errors throw (a malformed pointer is a host bug, not a failed call),
 * matching the original mock transport's behaviour.
 */
function bindMemory(
    ref: MemoryRef,
    reqPtr: number,
    reqLen: number,
    outPtr: number,
    outCap: number,
): Buffer<ArrayBuffer> {
    if (!ref.memory) throw new Error('daemon.http_call: memory is not bound');
    const memory = Buffer.from(ref.memory.buffer);
    if (
        [reqPtr, reqLen, outPtr, outCap].some((n) => !Number.isInteger(n) || n < 0) ||
        reqPtr > memory.length ||
        reqLen > memory.length - reqPtr ||
        outPtr > memory.length ||
        outCap > memory.length - outPtr
    )
        throw new Error('daemon.http_call: invalid memory range');
    if (reqLen > MAX_REQUEST_BYTES) throw new Error('daemon.http_call: request over cap');
    return memory;
}
/**
 * Decode a request envelope. Fail-closed: `null` means the guest sent something
 * malformed or over cap, which the caller reports as `DaemonCallFailed`.
 */
function decodeRequest(
    memory: Buffer<ArrayBuffer>,
    reqPtr: number,
    reqLen: number,
): DaemonHttpRequest|null {
    const request = Buffer.from(memory.subarray(reqPtr, reqPtr + reqLen));
    let offset = 0;
    const take = (length: number): Buffer => {
        if (length < 0 || length > request.length - offset) throw new Error('malformed request');
        const result = request.subarray(offset, offset + length);
        offset += length;
        return result;
    };
    const u16 = (): number => take(2).readUInt16LE();
    const str16 = (cap: number): string => {
        const size = u16();
        if (size > cap) throw new Error('field over cap');
        return UTF8.decode(take(size));
    };
    try {
        const methodLength = take(1)[0];
        if (methodLength === 0 || methodLength > MAX_METHOD_BYTES) return null;
        const method = UTF8.decode(take(methodLength));
        const url = str16(MAX_FIELD_BYTES);
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        const count = u16();
        if (count > MAX_HEADER_COUNT) return null;
        const headers: [string, string][] = [];
        for (let i = 0; i < count; i++)
            headers.push([str16(MAX_FIELD_BYTES), str16(MAX_FIELD_BYTES)]);
        const length = take(4).readUInt32LE();
        if (length > MAX_REQUEST_BYTES) return null;
        const body = Uint8Array.from(take(length));
        if (offset !== request.length) return null;
        return { method, url, headers, body };
    } catch {
        return null;
    }
}
/**
 * Encode a response envelope into the guest buffer. Returns the written length,
 * `TOO_SMALL` when it does not fit, or `FAILED` for an unusable response.
 */
function encodeResponse(
    memory: Buffer<ArrayBuffer>,
    outPtr: number,
    outCap: number,
    response: DaemonHttpResponse
): bigint {
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
        return FAILED;
    const headers = response.headers ?? [];
    if (headers.length > MAX_HEADER_COUNT) return FAILED;
    const head = Buffer.alloc(4);
    head.writeUInt16LE(response.status);
    head.writeUInt16LE(headers.length, 2);
    const fields: Buffer[] = [head];
    for (const pair of headers) {
        for (const value of pair) {
            const bytes = Buffer.from(value, 'utf8');
            if (bytes.length > MAX_FIELD_BYTES) return FAILED;
            const length = Buffer.alloc(2);
            length.writeUInt16LE(bytes.length);
            fields.push(length, bytes);
        }
    }
    const body = Buffer.from(response.body ?? []).subarray(0, MAX_RESPONSE_BYTES);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    fields.push(length, body);
    const encoded = Buffer.concat(fields);
    if (encoded.length > outCap) return TOO_SMALL;
    encoded.copy(memory, outPtr);
    return BigInt(encoded.length);
}

/**
 * Resolve a request envelope through a synchronous `handler`, writing the
 * response back into guest memory. Shared by both transports so the wire
 * behaviour (caps, fail-closed decoding, `TOO_SMALL`) cannot drift apart.
 *
 * @returns `FAILED` when no handler is installed or the request is malformed.
 */
function serveEnvelope(
    ref: MemoryRef,
    handler: DaemonHttpMock | undefined,
    reqPtr: number,
    reqLen: number,
    outPtr: number,
    outCap: number,
): bigint {
    const memory: Buffer<ArrayBuffer> = bindMemory(ref, reqPtr, reqLen, outPtr, outCap);
    if (!handler) return FAILED;
    const input = decodeRequest(memory, reqPtr, reqLen);
    if (input === null) return FAILED;
    const response = handler(input);
    if (response === null) return FAILED;
    return encodeResponse(memory, outPtr, outCap, response);
}
/**
 * Mock transport: resolve the request against an installed test hook.
 *
 * @param ref Guest memory binding.
 * @param mock Synchronous handler supplied by the caller, if any.
 * @returns Response envelope length, `TOO_SMALL`, or `FAILED`.
 */
export function mockDaemonHttp(
    ref: MemoryRef,
    mock: DaemonHttpMock | undefined,
    reqPtr: number,
    reqLen: number,
    outPtr: number,
    outCap: number,
): bigint {
    return serveEnvelope(ref, mock, reqPtr, reqLen, outPtr, outCap);
}
/**
 * Child program for the real transport: performs one fetch and prints a JSON
 * envelope on stdout. Kept as a string so the transport needs no extra file in
 * the published package.
 */
const REAL_CHILD = `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', async () => {
  let out;
  try {
    const req = JSON.parse(raw);
    const body = req.body ? Buffer.from(req.body, 'base64') : undefined;
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    // Stream the body under the cap so a large response can never make the
    // transport buffer more than the edge host itself would hold.
    const cap = req.maxResponseBytes;
    const chunks = [];
    let total = 0;
    let truncated = false;
    if (res.body) {
      for await (const c of res.body) {
        if (total >= cap) {
          truncated = true;
          break;
        }
        const slice = total + c.length > cap ? c.subarray(0, cap - total) : c;
        if (slice.length < c.length) truncated = true;
        chunks.push(Buffer.from(slice));
        total += slice.length;
      }
    }
    out = {
      status: res.status,
      headers: [...res.headers.entries()].map(([k, v]) => [k, v]),
      body: Buffer.concat(chunks).toString('base64'),
      truncated,
    };
  } catch (error) {
    out = { error: String((error && error.message) || error) };
  }
  process.stdout.write(JSON.stringify(out));
});
`;
/**
 * Real transport: issue an outbound HTTP request and return its response.
 *
 * Runs a single child process and blocks on it, because the wasm import has no
 * way to await. Returns `null` on any transport failure, which the caller
 * reports as `DaemonCallFailed` exactly as the edge host does.
 */
export function performRealHttpCall(input: DaemonHttpRequest, env = process.env): DaemonHttpResponse|null {
    const timeoutMs = realTimeoutMs(env);
    const payload = JSON.stringify({
        method: input.method,
        url: input.url,
        headers: input.headers,
        body: Buffer.from(input.body).toString('base64'),
        timeoutMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    const child = spawnSync(process.execPath, ['-e', REAL_CHILD], {
        input: payload,
        encoding: 'utf8',
        timeout: timeoutMs + CHILD_SLACK_MS,
        maxBuffer: CHILD_MAX_BUFFER,
    });
    if (child.error || child.status !== 0 || typeof child.stdout !== 'string') return null;
    let parsed: object;
    try {
        parsed = JSON.parse(child.stdout) as object;
    } catch {
        return null;
    }

    const parsedHeaders: unknown = 'headers' in parsed ? parsed.headers : null;
    const parsedStatus: unknown = 'status' in parsed ? parsed.status : null;
    const parsedBody: unknown = 'body' in parsed ? parsed.body : null;
    if (!parsed || typeof parsed !== 'object' || 'error' in parsed || !Number.isInteger(parsedStatus))
        return null;
    const headers: [string,string][] = Array.isArray(parsedHeaders)
        ? parsedHeaders.filter((pair) => Array.isArray(pair) && pair.length === 2) as [string,string][]
        : [];
    return {
        status: parsedStatus as number,
        headers: headers as [string,string][],
        body: Buffer.from(typeof parsedBody === 'string' ? parsedBody : '', 'base64'),
    };
}
/**
 * Real-mode entry point: same envelope contract as {@link mockDaemonHttp}, but
 * the response comes from the network rather than a test hook.
 */
export function realDaemonHttp(
    ref: MemoryRef,
    reqPtr: number,
    reqLen: number,
    outPtr: number,
    outCap: number,
    env = process.env,
): bigint {
    return serveEnvelope(
        ref,
        (input: DaemonHttpRequest) => performRealHttpCall(input, env),
        reqPtr,
        reqLen,
        outPtr,
        outCap,
    );
}
/**
 * Transport dispatcher used by the daemon host. An explicit `httpMock` always
 * wins, so a test that installs a hook is never surprised by the environment;
 * otherwise {@link DAEMON_HTTP_ENV} decides between the mock and the network.
 *
 * @returns Response envelope length, `TOO_SMALL`, or `FAILED`.
 */
export function daemonHttpCall(
    ref: MemoryRef,
    mock: DaemonHttpMock | undefined,
    reqPtr: number,
    reqLen: number,
    outPtr: number,
    outCap: number,
    env = process.env,
) {
    if (mock) return mockDaemonHttp(ref, mock, reqPtr, reqLen, outPtr, outCap);
    return daemonHttpMode(env) === 'real'
        ? realDaemonHttp(ref, reqPtr, reqLen, outPtr, outCap, env)
        : mockDaemonHttp(ref, mock, reqPtr, reqLen, outPtr, outCap);
}
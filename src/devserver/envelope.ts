/**
 * Node-side wire envelope codec for the WASM dev server, byte-for-byte compatible with
 * `server/runtime/envelope.ts` (the ToilScript guest decoder/encoder) and
 * `toil-backend/src/http/envelope.rs` (the production edge).
 *
 * Layout (little-endian, no padding):
 *
 *   request:
 *     u8   method     (0=GET, 1=POST, 2=PUT, 3=DELETE, 4=PATCH, 5=HEAD, 6=OPTIONS)
 *     u16  path_len
 *     [u8] path
 *     u16  n_headers
 *     for each header: u16 name_len, u16 val_len, [u8] name, [u8] val
 *     u32  body_len
 *     [u8] body
 *
 *   response: same shape but the first u8+u16 (method + path_len + path)
 *     is replaced by `u16 status`.
 *
 * Header names/values and the path must each fit in u16, the body in u32; the
 * encoder throws instead of silently truncating (mirrors `EncodeError` on the
 * edge). The decoder bounds-checks every length field so a malformed guest
 * response can never read past the envelope.
 */

/** Method discriminant matching the on-wire envelope byte (part of the wasm ABI; do not reorder). */
export const METHOD_CODES: Readonly<Record<string, number>> = {
    GET: 0,
    POST: 1,
    PUT: 2,
    DELETE: 3,
    PATCH: 4,
    HEAD: 5,
    OPTIONS: 6,
};

/** A request to serialize for the guest. `path` includes the query string. */
export interface EnvelopeRequest {
    readonly method: string;
    readonly path: string;
    /** Full request header list, passed through to the guest. */
    readonly headers: readonly (readonly [string, string])[];
    readonly body: Uint8Array;
}

/** The decoded guest response envelope. */
export interface EnvelopeResponse {
    readonly status: number;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: Uint8Array;
}

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/**
 * Encode `req` into a fresh buffer. Throws on an unsupported method or a field
 * that does not fit its length prefix; callers turn that into a clean 4xx (or
 * route the request past the guest) instead of handing the guest garbage.
 */
export function encodeRequestEnvelope(req: EnvelopeRequest): Buffer {
    const method = METHOD_CODES[req.method.toUpperCase()];
    if (method === undefined) throw new Error(`unsupported method: ${req.method}`);

    const path = Buffer.from(req.path, 'utf8');
    if (path.length > U16_MAX) throw new Error(`path too long: ${String(path.length)} bytes`);
    if (req.headers.length > U16_MAX)
        throw new Error(`too many headers: ${String(req.headers.length)}`);
    if (req.body.length > U32_MAX) throw new Error(`body too long: ${String(req.body.length)} bytes`);

    const headers: { name: Buffer; value: Buffer }[] = [];
    let headersSize = 0;
    for (const [name, value] of req.headers) {
        const n = Buffer.from(name, 'utf8');
        const v = Buffer.from(value, 'utf8');
        if (n.length > U16_MAX || v.length > U16_MAX)
            throw new Error(`header too long: ${name}`);
        headers.push({ name: n, value: v });
        headersSize += 4 + n.length + v.length;
    }

    const total = 1 + 2 + path.length + 2 + headersSize + 4 + req.body.length;
    const out = Buffer.allocUnsafe(total);
    let cur = 0;

    out.writeUInt8(method, cur);
    cur += 1;
    out.writeUInt16LE(path.length, cur);
    cur += 2;
    cur += path.copy(out, cur);

    out.writeUInt16LE(headers.length, cur);
    cur += 2;
    for (const h of headers) {
        out.writeUInt16LE(h.name.length, cur);
        cur += 2;
        out.writeUInt16LE(h.value.length, cur);
        cur += 2;
        cur += h.name.copy(out, cur);
        cur += h.value.copy(out, cur);
    }

    out.writeUInt32LE(req.body.length, cur);
    cur += 4;
    cur += Buffer.from(req.body.buffer, req.body.byteOffset, req.body.length).copy(out, cur);

    return out;
}

/**
 * Decode the response envelope the guest wrote at `bytes`. Throws on
 * truncation or a length field that overruns the envelope (a guest bug);
 * the dispatcher converts that into a 500.
 */
export function decodeResponseEnvelope(bytes: Uint8Array): EnvelopeResponse {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cur = 0;

    const take = (n: number): number => {
        if (cur + n > view.length)
            throw new Error(`response envelope truncated at byte ${String(cur)}`);
        const at = cur;
        cur += n;
        return at;
    };

    const status = view.readUInt16LE(take(2));
    if (status === 0) throw new Error('response envelope has status 0');

    const nHeaders = view.readUInt16LE(take(2));
    const headers: (readonly [string, string])[] = [];
    for (let i = 0; i < nHeaders; i++) {
        const nameLen = view.readUInt16LE(take(2));
        const valLen = view.readUInt16LE(take(2));
        const name = view.toString('utf8', take(nameLen), cur);
        const value = view.toString('utf8', take(valLen), cur);
        headers.push([name, value]);
    }

    const bodyLen = view.readUInt32LE(take(4));
    const bodyStart = take(bodyLen);
    // Copy out of the guest's linear memory so the response outlives the instance.
    const body = Uint8Array.prototype.slice.call(view, bodyStart, cur);

    return { status, headers, body };
}

/** Unpack the i64 `handle()` returns: high 32 bits = response offset, low 32 bits = byte length. */
export function unpackHandleResult(packed: bigint): { ptr: number; len: number } {
    return {
        ptr: Number((packed >> 32n) & 0xffffffffn),
        len: Number(packed & 0xffffffffn),
    };
}

/**
 * Wire envelope codec, byte-for-byte compatible with
 * `toil-backend/src/http/envelope.rs`.
 *
 * Layout (LE, no padding):
 *
 *   request:
 *     u8   method     (0=GET, 1=POST, 2=PUT, 3=DELETE,
 *                      4=PATCH, 5=HEAD, 6=OPTIONS)
 *     u16  path_len
 *     [u8] path
 *     u16  n_headers
 *     for each header: u16 name_len, u16 val_len, [u8] name, [u8] val
 *     u32  body_len
 *     [u8] body
 *
 *   response: same shape but the first u8+u16 (method + path_len)
 *     is replaced by `u16 status`.
 */

import { readU8, readU16, readU32, readBytes, readUtf8 } from './memory';
import { writeU16, writeU32, writeBytes, writeUtf8, utf8Length } from './memory';
import { Header, Method, Request } from './request';
import { Response } from './response';

class DecodeCursor {
    base: usize;
    end: usize;
    cur: usize;
    ok: bool;

    constructor(base: usize, len: usize) {
        this.base = base;
        this.end = base + len;
        this.cur = base;
        this.ok = true;
    }

    @inline canTake(n: usize): bool {
        return this.cur + n <= this.end;
    }

    takeU8(): u8 {
        if (!this.canTake(1)) { this.ok = false; return 0; }
        const v = readU8(this.cur);
        this.cur += 1;
        return v;
    }

    takeU16(): u16 {
        if (!this.canTake(2)) { this.ok = false; return 0; }
        const v = readU16(this.cur);
        this.cur += 2;
        return v;
    }

    takeU32(): u32 {
        if (!this.canTake(4)) { this.ok = false; return 0; }
        const v = readU32(this.cur);
        this.cur += 4;
        return v;
    }

    takeBytes(n: u32): Uint8Array {
        if (!this.canTake(<usize>n)) { this.ok = false; return new Uint8Array(0); }
        const out = readBytes(this.cur, n);
        this.cur += <usize>n;
        return out;
    }

    takeUtf8(n: u32): string {
        if (!this.canTake(<usize>n)) { this.ok = false; return ''; }
        const s = readUtf8(this.cur, n);
        this.cur += <usize>n;
        return s;
    }
}

/**
 * Decode the request envelope the host wrote at `req_ofs`. Returns
 * a populated `Request` on success or `null` on truncation /
 * malformed bytes.
 */
export function decodeRequest(req_ofs: usize, req_len: usize): Request | null {
    const c = new DecodeCursor(req_ofs, req_len);
    const methodByte = c.takeU8();
    if (!c.ok) return null;
    const method = methodFromByte(methodByte);

    const pathLen = c.takeU16();
    const path = c.takeUtf8(<u32>pathLen);
    if (!c.ok) return null;

    const nHeaders = c.takeU16();
    const headers = new Array<Header>();
    for (let i: u32 = 0; i < <u32>nHeaders; i++) {
        const nameLen = c.takeU16();
        const valLen = c.takeU16();
        const name = c.takeUtf8(<u32>nameLen);
        const val = c.takeUtf8(<u32>valLen);
        if (!c.ok) return null;
        headers.push(new Header(name, val));
    }

    const bodyLen = c.takeU32();
    const body = c.takeBytes(bodyLen);
    if (!c.ok) return null;

    return new Request(method, path, headers, body);
}

@inline function methodFromByte(b: u8): Method {
    if (b == 0) return Method.GET;
    if (b == 1) return Method.POST;
    if (b == 2) return Method.PUT;
    if (b == 3) return Method.DELETE;
    if (b == 4) return Method.PATCH;
    if (b == 5) return Method.HEAD;
    if (b == 6) return Method.OPTIONS;
    return Method.UNKNOWN;
}

/**
 * Serialise `resp` into linear memory starting at `dst_ofs`.
 * Returns the total byte length written. Status, header count and
 * body length are bounds-checked: header names and values must each
 * fit in u16, the body must fit in u32, the header count must fit in
 * u16. A handler returning an unrepresentable response gets a
 * minimal 500 envelope written instead so the host never sees an
 * encoder fault.
 */
export function encodeResponse(resp: Response, dst_ofs: usize): u32 {
    // Validate fits-in-u16/u32 limits up front so we never half-write.
    if (resp.headers.length > 0xffff) {
        return encodeFallback500(dst_ofs);
    }
    for (let i = 0; i < resp.headers.length; i++) {
        const h = resp.headers[i];
        if (utf8Length(h.name) > 0xffff || utf8Length(h.value) > 0xffff) {
            return encodeFallback500(dst_ofs);
        }
    }
    if (<u64>resp.body.length > <u64>0xffffffff) {
        return encodeFallback500(dst_ofs);
    }

    let cur: usize = dst_ofs;

    writeU16(cur, resp.status);
    cur += 2;

    writeU16(cur, <u16>resp.headers.length);
    cur += 2;

    for (let i = 0; i < resp.headers.length; i++) {
        const h = resp.headers[i];
        const nameLen = utf8Length(h.name);
        const valLen = utf8Length(h.value);
        writeU16(cur, <u16>nameLen);
        cur += 2;
        writeU16(cur, <u16>valLen);
        cur += 2;
        cur += writeUtf8(cur, h.name);
        cur += writeUtf8(cur, h.value);
    }

    const bodyLen = <u32>resp.body.length;
    writeU32(cur, bodyLen);
    cur += 4;
    cur += writeBytes(cur, resp.body);

    return <u32>(cur - dst_ofs);
}

function encodeFallback500(dst_ofs: usize): u32 {
    // Minimal valid 500 envelope: status + 0 headers + 0-length body.
    writeU16(dst_ofs, 500);
    writeU16(dst_ofs + 2, 0);
    writeU32(dst_ofs + 4, 0);
    return 8;
}

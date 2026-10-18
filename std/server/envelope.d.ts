// Generated from server/runtime by scripts/gen-server-types.mjs.
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
import { Request } from './request';
import { Response } from './response';
/**
 * Decode the request envelope the host wrote at `req_ofs`. Returns
 * a populated `Request` on success or `null` on truncation /
 * malformed bytes.
 */
export declare function decodeRequest(req_ofs: usize, req_len: usize): Request | null;
/**
 * Serialise `resp` into linear memory starting at `dst_ofs`.
 * Returns the total byte length written. Status, header count and
 * body length are bounds-checked: header names and values must each
 * fit in u16, the body must fit in u32, the header count must fit in
 * u16. A handler returning an unrepresentable response gets a
 * minimal 500 envelope written instead so the host never sees an
 * encoder fault.
 */
export declare function encodeResponse(resp: Response, dst_ofs: usize): u32;

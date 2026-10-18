// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * Tiny load/store wrappers around AssemblyScript's linear-memory
 * intrinsics. The envelope codec stays readable when it calls
 * `readU16(p)` instead of `load<u16>(p)` everywhere.
 *
 * All reads are little-endian (matches the wire format produced by
 * `toil-backend/src/http/envelope.rs`).
 */
export declare function readU8(ofs: usize): u8;
export declare function readU16(ofs: usize): u16;
export declare function readU32(ofs: usize): u32;
export declare function writeU8(ofs: usize, v: u8): void;
export declare function writeU16(ofs: usize, v: u16): void;
export declare function writeU32(ofs: usize, v: u32): void;
/**
 * Read `len` bytes starting at `ofs` and return them as a fresh
 * `Uint8Array` (copying out of linear memory). Used for the request
 * body so the handler can hold onto it past the call to `dispatch`.
 */
export declare function readBytes(ofs: usize, len: u32): Uint8Array;
/**
 * Write `bytes` into linear memory starting at `ofs`. Returns the
 * number of bytes written.
 */
export declare function writeBytes(ofs: usize, bytes: Uint8Array): u32;
/**
 * Decode `len` bytes of UTF-8 at `ofs` into a string. The bytes
 * remain in linear memory; the returned string is a fresh AS string.
 */
export declare function readUtf8(ofs: usize, len: u32): string;
/**
 * Encode `s` as UTF-8 into linear memory starting at `ofs`. Returns
 * the number of bytes written.
 */
export declare function writeUtf8(ofs: usize, s: string): u32;
/**
 * UTF-8 byte length of `s` without actually writing it anywhere.
 * Used by the response encoder to pre-compute total envelope size
 * before laying out the bytes.
 */
export declare function utf8Length(s: string): u32;

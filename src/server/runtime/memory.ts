/**
 * Tiny load/store wrappers around AssemblyScript's linear-memory
 * intrinsics. The envelope codec stays readable when it calls
 * `readU16(p)` instead of `load<u16>(p)` everywhere.
 *
 * All reads are little-endian (matches the wire format produced by
 * `toil-backend/src/http/envelope.rs`).
 */

@inline export function readU8(ofs: usize): u8 {
    return load<u8>(ofs);
}

@inline export function readU16(ofs: usize): u16 {
    return load<u16>(ofs);
}

@inline export function readU32(ofs: usize): u32 {
    return load<u32>(ofs);
}

@inline export function writeU8(ofs: usize, v: u8): void {
    store<u8>(ofs, v);
}

@inline export function writeU16(ofs: usize, v: u16): void {
    store<u16>(ofs, v);
}

@inline export function writeU32(ofs: usize, v: u32): void {
    store<u32>(ofs, v);
}

/**
 * Read `len` bytes starting at `ofs` and return them as a fresh
 * `Uint8Array` (copying out of linear memory). Used for the request
 * body so the handler can hold onto it past the call to `dispatch`.
 */
export function readBytes(ofs: usize, len: u32): Uint8Array {
    const out = new Uint8Array(<i32>len);
    memory.copy(changetype<usize>(out.dataStart), ofs, <usize>len);
    return out;
}

/**
 * Write `bytes` into linear memory starting at `ofs`. Returns the
 * number of bytes written.
 */
export function writeBytes(ofs: usize, bytes: Uint8Array): u32 {
    const n = <u32>bytes.length;
    memory.copy(ofs, changetype<usize>(bytes.dataStart), <usize>n);
    return n;
}

/**
 * Decode `len` bytes of UTF-8 at `ofs` into a string. The bytes
 * remain in linear memory; the returned string is a fresh AS string.
 */
export function readUtf8(ofs: usize, len: u32): string {
    return String.UTF8.decodeUnsafe(ofs, <usize>len);
}

/**
 * Encode `s` as UTF-8 into linear memory starting at `ofs`. Returns
 * the number of bytes written.
 */
export function writeUtf8(ofs: usize, s: string): u32 {
    const buf = String.UTF8.encode(s);
    const n = <u32>buf.byteLength;
    memory.copy(ofs, changetype<usize>(buf), <usize>n);
    return n;
}

/**
 * UTF-8 byte length of `s` without actually writing it anywhere.
 * Used by the response encoder to pre-compute total envelope size
 * before laying out the bytes.
 */
@inline export function utf8Length(s: string): u32 {
    return <u32>String.UTF8.byteLength(s, false);
}

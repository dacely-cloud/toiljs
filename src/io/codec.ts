/**
 * TypeScript side of the `@data` binary codec, byte-for-byte compatible with the
 * ToilScript `DataWriter`/`DataReader` in `std/assembly/data.ts`.
 *
 * Little-endian by default (wasm `store`/`load` are little-endian, so the ToilScript
 * side is near native and this matches it). Every multi-byte method takes an optional
 * `be` flag to read/write big-endian instead, for interop with big-endian wire
 * formats; the generated `@data` code never sets it, so the `@data` wire stays
 * little-endian. Strings and byte blobs are a `u32` byte-length prefix followed by the
 * bytes. `u128`/`i128` are two 64-bit limbs (low limb first in little-endian, high
 * limb first in big-endian), `u256`/`i256` four. The reader never throws: a read past
 * the end clears {@link DataReader.ok} and yields a zero/empty value.
 */

const MASK64 = 0xffffffffffffffffn;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * A growable little-endian (or big-endian, per the `be` flag) byte writer. Methods
 * return `this` so writes chain. The backing buffer doubles as needed; call
 * {@link toBytes} for an exact-length copy of what was written.
 */
export class DataWriter {
    // `ArrayBuffer`-backed (not the `ArrayBufferLike` default) so `toBytes()` yields a
    // `Uint8Array<ArrayBuffer>`, which `fetch`/`Blob`/`Response` accept as a `BodyInit`.
    private buf: Uint8Array<ArrayBuffer>;
    private view: DataView;
    private off = 0;

    /** @param capacity - initial buffer size in bytes (grows automatically). */
    constructor(capacity = 64) {
        this.buf = new Uint8Array(capacity > 0 ? capacity : 1);
        this.view = new DataView(this.buf.buffer);
    }

    /**
     * Ensures room for `extra` more bytes and returns the offset to write at. Grows
     * (doubling) when needed, reassigning `buf`/`view`. Callers MUST read the returned
     * offset into a local before touching `this.view`/`this.buf`, since a grow swaps
     * them out from under a stale receiver.
     */
    private reserve(extra: number): number {
        const need = this.off + extra;
        if (need > this.buf.length) {
            let n = this.buf.length;
            while (n < need) n <<= 1;
            const bigger = new Uint8Array(n);
            bigger.set(this.buf.subarray(0, this.off));
            this.buf = bigger;
            this.view = new DataView(this.buf.buffer);
        }
        const at = this.off;
        this.off += extra;
        return at;
    }

    /** Writes an unsigned 8-bit byte (the low 8 bits of `v`). */
    writeU8(v: number): this { const at = this.reserve(1); this.view.setUint8(at, v & 0xff); return this; }
    /** Writes an unsigned 16-bit integer. @param be - big-endian if true (default little-endian). */
    writeU16(v: number, be?: boolean): this { const at = this.reserve(2); this.view.setUint16(at, v & 0xffff, !be); return this; }
    /** Writes an unsigned 32-bit integer. @param be - big-endian if true (default little-endian). */
    writeU32(v: number, be?: boolean): this { const at = this.reserve(4); this.view.setUint32(at, v >>> 0, !be); return this; }
    /** Writes an unsigned 64-bit integer (low 64 bits of `v`). @param be - big-endian if true. */
    writeU64(v: bigint, be?: boolean): this { const at = this.reserve(8); this.view.setBigUint64(at, v & MASK64, !be); return this; }
    /** Writes a signed 8-bit integer. */
    writeI8(v: number): this { const at = this.reserve(1); this.view.setInt8(at, v); return this; }
    /** Writes a signed 16-bit integer. @param be - big-endian if true (default little-endian). */
    writeI16(v: number, be?: boolean): this { const at = this.reserve(2); this.view.setInt16(at, v, !be); return this; }
    /** Writes a signed 32-bit integer. @param be - big-endian if true (default little-endian). */
    writeI32(v: number, be?: boolean): this { const at = this.reserve(4); this.view.setInt32(at, v | 0, !be); return this; }
    /** Writes a signed 64-bit integer. @param be - big-endian if true (default little-endian). */
    writeI64(v: bigint, be?: boolean): this { const at = this.reserve(8); this.view.setBigInt64(at, BigInt.asIntN(64, v), !be); return this; }
    /** Writes a 32-bit float. @param be - big-endian if true (default little-endian). */
    writeF32(v: number, be?: boolean): this { const at = this.reserve(4); this.view.setFloat32(at, v, !be); return this; }
    /** Writes a 64-bit float. @param be - big-endian if true (default little-endian). */
    writeF64(v: number, be?: boolean): this { const at = this.reserve(8); this.view.setFloat64(at, v, !be); return this; }
    /** Writes a boolean as one byte (1 or 0). */
    writeBool(v: boolean): this { return this.writeU8(v ? 1 : 0); }

    /** Writes the `count` 64-bit limbs of `u` (low limb first in LE, high limb first in BE). */
    private writeLimbs(u: bigint, count: number, be: boolean): this {
        if (be) {
            for (let i = count - 1; i >= 0; i--) this.writeU64((u >> BigInt(i * 64)) & MASK64, true);
        } else {
            for (let i = 0; i < count; i++) this.writeU64((u >> BigInt(i * 64)) & MASK64, false);
        }
        return this;
    }

    /** Writes a `u32` length prefix followed by the raw bytes. @param be - endianness of the prefix. */
    writeBytes(bytes: Uint8Array, be?: boolean): this {
        this.writeU32(bytes.length, be);
        if (bytes.length) {
            const at = this.reserve(bytes.length);
            this.buf.set(bytes, at);
        }
        return this;
    }

    /** Writes a `u32` byte-length prefix followed by the UTF-8 bytes. @param be - endianness of the prefix. */
    writeString(value: string, be?: boolean): this {
        const utf8 = utf8Encoder.encode(value);
        this.writeU32(utf8.length, be);
        if (utf8.length) {
            const at = this.reserve(utf8.length);
            this.buf.set(utf8, at);
        }
        return this;
    }

    /** Writes an unsigned 128-bit integer as two 64-bit limbs. @param be - big-endian if true. */
    writeU128(v: bigint, be?: boolean): this { return this.writeLimbs(BigInt.asUintN(128, v), 2, !!be); }
    /** Writes a signed 128-bit integer as two 64-bit limbs (two's complement). @param be - big-endian if true. */
    writeI128(v: bigint, be?: boolean): this { return this.writeLimbs(BigInt.asUintN(128, v), 2, !!be); }
    /** Writes an unsigned 256-bit integer as four 64-bit limbs. @param be - big-endian if true. */
    writeU256(v: bigint, be?: boolean): this { return this.writeLimbs(BigInt.asUintN(256, v), 4, !!be); }
    /** Writes a signed 256-bit integer as four 64-bit limbs (two's complement). @param be - big-endian if true. */
    writeI256(v: bigint, be?: boolean): this { return this.writeLimbs(BigInt.asUintN(256, v), 4, !!be); }

    /** Number of bytes written so far. */
    length(): number { return this.off; }

    /** A fresh copy of exactly the bytes written. */
    toBytes(): Uint8Array<ArrayBuffer> { return this.buf.slice(0, this.off); }
}

/**
 * Reads values written by {@link DataWriter}. Never throws: a read past the end
 * clears {@link ok} and returns a zero/empty value, so a truncated or hostile buffer
 * fails closed rather than crashing. Defaults to little-endian; pass `be` to match a
 * big-endian writer.
 */
export class DataReader {
    private buf: Uint8Array;
    private view: DataView;
    private off = 0;
    /** Cleared to false if any read ran past the end of the buffer. */
    ok = true;

    /** @param bytes - the buffer to read from (its byteOffset/length are respected). */
    constructor(bytes: Uint8Array) {
        this.buf = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    /** Returns true (and leaves `off` advanceable) if `n` more bytes are available; else clears `ok`. */
    private has(n: number): boolean {
        if (n < 0 || this.off + n > this.buf.length) {
            this.ok = false;
            return false;
        }
        return true;
    }

    /** Reads an unsigned 8-bit byte (0 past end). */
    readU8(): number { if (!this.has(1)) return 0; const v = this.view.getUint8(this.off); this.off += 1; return v; }
    /** Reads an unsigned 16-bit integer. @param be - big-endian if true (default little-endian). */
    readU16(be?: boolean): number { if (!this.has(2)) return 0; const v = this.view.getUint16(this.off, !be); this.off += 2; return v; }
    /** Reads an unsigned 32-bit integer. @param be - big-endian if true (default little-endian). */
    readU32(be?: boolean): number { if (!this.has(4)) return 0; const v = this.view.getUint32(this.off, !be); this.off += 4; return v >>> 0; }
    /** Reads an unsigned 64-bit integer. @param be - big-endian if true (default little-endian). */
    readU64(be?: boolean): bigint { if (!this.has(8)) return 0n; const v = this.view.getBigUint64(this.off, !be); this.off += 8; return v; }
    /** Reads a signed 8-bit integer (0 past end). */
    readI8(): number { if (!this.has(1)) return 0; const v = this.view.getInt8(this.off); this.off += 1; return v; }
    /** Reads a signed 16-bit integer. @param be - big-endian if true (default little-endian). */
    readI16(be?: boolean): number { if (!this.has(2)) return 0; const v = this.view.getInt16(this.off, !be); this.off += 2; return v; }
    /** Reads a signed 32-bit integer. @param be - big-endian if true (default little-endian). */
    readI32(be?: boolean): number { if (!this.has(4)) return 0; const v = this.view.getInt32(this.off, !be); this.off += 4; return v; }
    /** Reads a signed 64-bit integer. @param be - big-endian if true (default little-endian). */
    readI64(be?: boolean): bigint { if (!this.has(8)) return 0n; const v = this.view.getBigInt64(this.off, !be); this.off += 8; return v; }
    /** Reads a 32-bit float. @param be - big-endian if true (default little-endian). */
    readF32(be?: boolean): number { if (!this.has(4)) return 0; const v = this.view.getFloat32(this.off, !be); this.off += 4; return v; }
    /** Reads a 64-bit float. @param be - big-endian if true (default little-endian). */
    readF64(be?: boolean): number { if (!this.has(8)) return 0; const v = this.view.getFloat64(this.off, !be); this.off += 8; return v; }
    /** Reads a boolean (any non-zero byte is true). */
    readBool(): boolean { return this.readU8() !== 0; }

    /** Reads `count` 64-bit limbs and recombines them (low limb first in LE, high first in BE). */
    private readLimbs(count: number, be: boolean): bigint {
        let result = 0n;
        if (be) {
            for (let i = count - 1; i >= 0; i--) result |= this.readU64(true) << BigInt(i * 64);
        } else {
            for (let i = 0; i < count; i++) result |= this.readU64(false) << BigInt(i * 64);
        }
        return result;
    }

    /** Reads a `u32`-length-prefixed byte blob (empty past end). @param be - endianness of the prefix. */
    readBytes(be?: boolean): Uint8Array {
        const len = this.readU32(be);
        if (!this.has(len)) return new Uint8Array(0);
        const out = this.buf.slice(this.off, this.off + len);
        this.off += len;
        return out;
    }

    /** Reads a `u32`-byte-length-prefixed UTF-8 string (empty past end). @param be - endianness of the prefix. */
    readString(be?: boolean): string {
        const len = this.readU32(be);
        if (!this.has(len)) return "";
        const s = utf8Decoder.decode(this.buf.subarray(this.off, this.off + len));
        this.off += len;
        return s;
    }

    /** Reads an unsigned 128-bit integer. @param be - big-endian if true (default little-endian). */
    readU128(be?: boolean): bigint { return this.readLimbs(2, !!be); }
    /** Reads a signed 128-bit integer (two's complement). @param be - big-endian if true. */
    readI128(be?: boolean): bigint { return BigInt.asIntN(128, this.readLimbs(2, !!be)); }
    /** Reads an unsigned 256-bit integer. @param be - big-endian if true (default little-endian). */
    readU256(be?: boolean): bigint { return this.readLimbs(4, !!be); }
    /** Reads a signed 256-bit integer (two's complement). @param be - big-endian if true. */
    readI256(be?: boolean): bigint { return BigInt.asIntN(256, this.readLimbs(4, !!be)); }

    /** Bytes left to read. */
    remaining(): number { return this.buf.length - this.off; }
}

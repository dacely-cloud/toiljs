/**
 * TypeScript side of the `@data` binary codec, byte-for-byte compatible with the
 * ToilScript `DataWriter`/`DataReader` in `std/assembly/data.ts`.
 *
 * Little-endian throughout (wasm `store`/`load` are little-endian, so the
 * ToilScript side is near native and this matches it). Strings and byte blobs are
 * a `u32` byte-length prefix followed by the bytes. `u128`/`i128` are two 64-bit
 * limbs (lo then hi), `u256` four. Generated `@data` classes call these
 * primitives; arrays and nested values are handled by the generated
 * encode/decode, mirroring the ToilScript code.
 */

const MASK64 = 0xffffffffffffffffn;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export class DataWriter {
    private buf: Uint8Array;
    private view: DataView;
    private off = 0;

    constructor(capacity = 64) {
        this.buf = new Uint8Array(capacity > 0 ? capacity : 1);
        this.view = new DataView(this.buf.buffer);
    }

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

    writeU8(v: number): this { this.view.setUint8(this.reserve(1), v & 0xff); return this; }
    writeU16(v: number): this { this.view.setUint16(this.reserve(2), v & 0xffff, true); return this; }
    writeU32(v: number): this { this.view.setUint32(this.reserve(4), v >>> 0, true); return this; }
    writeU64(v: bigint): this { this.view.setBigUint64(this.reserve(8), v & MASK64, true); return this; }
    writeI8(v: number): this { this.view.setInt8(this.reserve(1), v); return this; }
    writeI16(v: number): this { this.view.setInt16(this.reserve(2), v, true); return this; }
    writeI32(v: number): this { this.view.setInt32(this.reserve(4), v | 0, true); return this; }
    writeI64(v: bigint): this { this.view.setBigInt64(this.reserve(8), BigInt.asIntN(64, v), true); return this; }
    writeF32(v: number): this { this.view.setFloat32(this.reserve(4), v, true); return this; }
    writeF64(v: number): this { this.view.setFloat64(this.reserve(8), v, true); return this; }
    writeBool(v: boolean): this { return this.writeU8(v ? 1 : 0); }

    writeBytes(bytes: Uint8Array): this {
        this.writeU32(bytes.length);
        if (bytes.length) this.buf.set(bytes, this.reserve(bytes.length));
        return this;
    }

    writeString(value: string): this {
        const utf8 = utf8Encoder.encode(value);
        this.writeU32(utf8.length);
        if (utf8.length) this.buf.set(utf8, this.reserve(utf8.length));
        return this;
    }

    writeU128(v: bigint): this {
        const u = BigInt.asUintN(128, v);
        return this.writeU64(u & MASK64).writeU64((u >> 64n) & MASK64);
    }

    writeI128(v: bigint): this {
        const u = BigInt.asUintN(128, v);
        return this.writeU64(u & MASK64).writeI64(BigInt.asIntN(64, u >> 64n));
    }

    writeU256(v: bigint): this {
        const u = BigInt.asUintN(256, v);
        return this.writeU64(u & MASK64)
            .writeU64((u >> 64n) & MASK64)
            .writeU64((u >> 128n) & MASK64)
            .writeU64((u >> 192n) & MASK64);
    }

    length(): number { return this.off; }

    toBytes(): Uint8Array { return this.buf.slice(0, this.off); }
}

export class DataReader {
    private buf: Uint8Array;
    private view: DataView;
    private off = 0;
    /** Cleared to false if any read ran past the end of the buffer. */
    ok = true;

    constructor(bytes: Uint8Array) {
        this.buf = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    private has(n: number): boolean {
        if (n < 0 || this.off + n > this.buf.length) {
            this.ok = false;
            return false;
        }
        return true;
    }

    readU8(): number { if (!this.has(1)) return 0; const v = this.view.getUint8(this.off); this.off += 1; return v; }
    readU16(): number { if (!this.has(2)) return 0; const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
    readU32(): number { if (!this.has(4)) return 0; const v = this.view.getUint32(this.off, true); this.off += 4; return v >>> 0; }
    readU64(): bigint { if (!this.has(8)) return 0n; const v = this.view.getBigUint64(this.off, true); this.off += 8; return v; }
    readI8(): number { if (!this.has(1)) return 0; const v = this.view.getInt8(this.off); this.off += 1; return v; }
    readI16(): number { if (!this.has(2)) return 0; const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
    readI32(): number { if (!this.has(4)) return 0; const v = this.view.getInt32(this.off, true); this.off += 4; return v; }
    readI64(): bigint { if (!this.has(8)) return 0n; const v = this.view.getBigInt64(this.off, true); this.off += 8; return v; }
    readF32(): number { if (!this.has(4)) return 0; const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
    readF64(): number { if (!this.has(8)) return 0; const v = this.view.getFloat64(this.off, true); this.off += 8; return v; }
    readBool(): boolean { return this.readU8() !== 0; }

    readBytes(): Uint8Array {
        const len = this.readU32();
        if (!this.has(len)) return new Uint8Array(0);
        const out = this.buf.slice(this.off, this.off + len);
        this.off += len;
        return out;
    }

    readString(): string {
        const len = this.readU32();
        if (!this.has(len)) return "";
        const s = utf8Decoder.decode(this.buf.subarray(this.off, this.off + len));
        this.off += len;
        return s;
    }

    readU128(): bigint {
        const lo = this.readU64();
        return lo | (this.readU64() << 64n);
    }

    readI128(): bigint {
        const lo = this.readU64();
        return BigInt.asIntN(128, lo | (BigInt.asUintN(64, this.readI64()) << 64n));
    }

    readU256(): bigint {
        const lo1 = this.readU64();
        const lo2 = this.readU64();
        const hi1 = this.readU64();
        return lo1 | (lo2 << 64n) | (hi1 << 128n) | (this.readU64() << 192n);
    }

    remaining(): number { return this.buf.length - this.off; }
}

import { describe, expect, it } from 'vitest';

import { DataReader, DataWriter } from '../src/io/codec';
import { FastMap } from '../src/io/FastMap';
import { FastSet } from '../src/io/FastSet';

describe('DataWriter / DataReader', () => {
    it('round-trips fixed-width integers', () => {
        const w = new DataWriter();
        w.writeU8(255).writeU16(65535).writeU32(4294967295).writeU64(18446744073709551615n);
        w.writeI8(-128).writeI16(-32768).writeI32(-2147483648).writeI64(-9223372036854775808n);

        const r = new DataReader(w.toBytes());
        expect(r.readU8()).toBe(255);
        expect(r.readU16()).toBe(65535);
        expect(r.readU32()).toBe(4294967295);
        expect(r.readU64()).toBe(18446744073709551615n);
        expect(r.readI8()).toBe(-128);
        expect(r.readI16()).toBe(-32768);
        expect(r.readI32()).toBe(-2147483648);
        expect(r.readI64()).toBe(-9223372036854775808n);
        expect(r.ok).toBe(true);
        expect(r.remaining()).toBe(0);
    });

    it('round-trips floats, bool, bytes and strings', () => {
        const w = new DataWriter();
        w.writeF32(0.5).writeF64(3.141592653589793).writeBool(true).writeBool(false);
        w.writeBytes(new Uint8Array([1, 2, 3, 0, 255]));
        w.writeString('hello toil 🛠');

        const r = new DataReader(w.toBytes());
        expect(r.readF32()).toBe(0.5);
        expect(r.readF64()).toBe(3.141592653589793);
        expect(r.readBool()).toBe(true);
        expect(r.readBool()).toBe(false);
        expect([...r.readBytes()]).toEqual([1, 2, 3, 0, 255]);
        expect(r.readString()).toBe('hello toil 🛠');
        expect(r.ok).toBe(true);
    });

    it('round-trips u128 / i128 / u256 / i256', () => {
        const u = 123456789012345678901234567890n;
        const big256 = (2n ** 256n) - 1n;
        const w = new DataWriter();
        w.writeU128(u).writeI128(-1234567890123456789n).writeU256(big256).writeI256(-(2n ** 200n));

        const r = new DataReader(w.toBytes());
        expect(r.readU128()).toBe(u);
        expect(r.readI128()).toBe(-1234567890123456789n);
        expect(r.readU256()).toBe(big256);
        expect(r.readI256()).toBe(-(2n ** 200n));
    });

    it('grows past the initial capacity without corruption (regression)', () => {
        // The default buffer is 64 bytes; this forces several reallocations.
        const w = new DataWriter();
        const text = 'z'.repeat(500);
        for (let i = 0; i < 40; i++) w.writeU64(BigInt(i)); // 320 bytes
        w.writeString(text);

        const r = new DataReader(w.toBytes());
        for (let i = 0; i < 40; i++) expect(r.readU64()).toBe(BigInt(i));
        expect(r.readString()).toBe(text);
        expect(r.ok).toBe(true);
    });

    it('round-trips big-endian when be is set, and be flips byte order', () => {
        expect([...new DataWriter().writeU32(0x01020304).toBytes()]).toEqual([4, 3, 2, 1]);
        expect([...new DataWriter().writeU32(0x01020304, true).toBytes()]).toEqual([1, 2, 3, 4]);

        const w = new DataWriter();
        w.writeU16(0xabcd, true).writeI32(-2, true).writeU64(0xdeadbeefn, true).writeU128(123456789012345n, true);
        const r = new DataReader(w.toBytes());
        expect(r.readU16(true)).toBe(0xabcd);
        expect(r.readI32(true)).toBe(-2);
        expect(r.readU64(true)).toBe(0xdeadbeefn);
        expect(r.readU128(true)).toBe(123456789012345n);
    });

    it('is little-endian and masks instead of throwing', () => {
        // u32 1 → 01 00 00 00 (LE); writeU8 masks to a byte, no throw.
        const bytes = new DataWriter().writeU32(1).writeU8(256).toBytes();
        expect([...bytes]).toEqual([1, 0, 0, 0, 0]);
    });

    it('reports ok=false when reading past the end (no throw)', () => {
        const r = new DataReader(new Uint8Array(2));
        expect(r.readU32()).toBe(0);
        expect(r.ok).toBe(false);
    });
});

describe('FastMap', () => {
    it('supports bigint keys and basic ops', () => {
        const m = new FastMap<bigint, string>();
        m.set(1n, 'one').set(2n, 'two');
        expect(m.size).toBe(2);
        expect(m.get(1n)).toBe('one');
        expect(m.has(2n)).toBe(true);
        expect(m.delete(1n)).toBe(true);
        expect(m.has(1n)).toBe(false);
        expect([...m.entries()]).toEqual([[2n, 'two']]);
    });
});

describe('FastSet', () => {
    it('dedupes and preserves insertion order', () => {
        const s = new FastSet<bigint>();
        s.add(2n).add(1n).add(2n);
        expect(s.size).toBe(2);
        expect(s.has(1n)).toBe(true);
        expect([...s.values()]).toEqual([2n, 1n]);
        expect(s.delete(2n)).toBe(true);
        expect([...s.values()]).toEqual([1n]);
    });
});

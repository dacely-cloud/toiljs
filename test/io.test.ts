import { describe, expect, it } from 'vitest';

import { BinaryReader } from '../src/io/BinaryReader';
import { BinaryWriter } from '../src/io/BinaryWriter';
import { FastMap } from '../src/io/FastMap';
import { FastSet } from '../src/io/FastSet';

describe('BinaryWriter / BinaryReader', () => {
    it('round-trips fixed-width integers', () => {
        const w = new BinaryWriter();
        w.writeU8(255);
        w.writeU16(65535);
        w.writeU32(4294967295);
        w.writeU64(18446744073709551615n);
        w.writeI8(-128);
        w.writeI32(-2147483648);

        const r = new BinaryReader(w.getBuffer());
        expect(r.readU8()).toBe(255);
        expect(r.readU16()).toBe(65535);
        expect(r.readU32()).toBe(4294967295);
        expect(r.readU64()).toBe(18446744073709551615n);
        expect(r.readI8()).toBe(-128);
        expect(r.readI32()).toBe(-2147483648);
    });

    it('round-trips u256 and strings', () => {
        const big = 123456789012345678901234567890n;
        const w = new BinaryWriter();
        w.writeU256(big);
        w.writeStringWithLength('hello toil 🛠');
        w.writeBoolean(true);

        const r = new BinaryReader(w.getBuffer());
        expect(r.readU256()).toBe(big);
        expect(r.readStringWithLength()).toBe('hello toil 🛠');
        expect(r.readBoolean()).toBe(true);
    });

    it('round-trips arrays', () => {
        const w = new BinaryWriter();
        w.writeU32Array([1, 2, 3]);
        w.writeStringArray(['a', 'bb', 'ccc']);

        const r = new BinaryReader(w.getBuffer());
        expect(r.readU32Array()).toEqual([1, 2, 3]);
        expect(r.readStringArray()).toEqual(['a', 'bb', 'ccc']);
    });

    it('rejects out-of-range values', () => {
        const w = new BinaryWriter();
        expect(() => w.writeU8(256)).toThrow();
        expect(() => w.writeI8(128)).toThrow();
    });

    it('throws when reading past the end', () => {
        const r = new BinaryReader(new Uint8Array(2));
        expect(() => r.readU32()).toThrow();
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

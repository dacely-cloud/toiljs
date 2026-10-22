import { expect, it } from 'vitest';
import { buildBase64Imports } from '../src/devserver/runtime/base64.js';

it('matches native base64 wire format across lengths, alphabets, padding and malformed inputs', () => {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const bytes = Buffer.from(memory.buffer);
    const codec = buildBase64Imports({ memory });
    for (let size = 0; size < 130; size++) {
        const input = Buffer.from(Array.from({ length: size }, (_, i) => (i * 71 + size) & 255));
        bytes.set(input, 0);
        const chars = codec['codec.base64url_encode'](0, size, 4096, 1024);
        expect(bytes.toString('utf16le', 4096, 4096 + chars * 2)).toBe(input.toString('base64url'));
        const count = codec['codec.base64url_decode'](4096, chars, 8192, 1024);
        expect(bytes.subarray(8192, 8192 + count)).toEqual(input);
    }
    for (const value of ['AA', 'AB', '-_8', '+/8=', ' + / 8 =\r\n', '']) {
        bytes.set(Buffer.from(value, 'utf16le'), 0);
        const count = codec['codec.base64url_decode'](0, value.length, 8192, 1024);
        expect(count).toBeGreaterThanOrEqual(0);
        expect(bytes.subarray(8192, 8192 + count)).toEqual(
            Buffer.from(value.replace(/\s|=/g, ''), 'base64'),
        );
    }
    for (const value of ['A', 'A=', 'é', 'AA$', 'あ']) {
        bytes.set(Buffer.from(value, 'utf16le'), 0);
        expect(codec['codec.base64url_decode'](0, value.length, 8192, 1024)).toBe(-1);
    }
    expect(codec['codec.base64url_encode'](0, 65537, 4096, 1024)).toBe(-1);
    expect(() => codec['codec.base64url_decode'](-1, 4, 4096, 1024)).toThrow();
});

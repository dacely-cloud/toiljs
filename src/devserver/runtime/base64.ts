import type { MemoryRef } from './host.js';

/** Matches the bounded native UTF-16 codec ABI. */
export function buildBase64Imports(ref: MemoryRef): Record<string, (...args: number[]) => number> {
    const span = (ptr: number, length: number): Buffer => {
        const buffer = ref.memory?.buffer;
        if (
            !buffer ||
            ptr < 0 ||
            length < 0 ||
            ptr > buffer.byteLength ||
            length > buffer.byteLength - ptr
        )
            throw new RangeError('base64 codec memory bounds');
        return Buffer.from(buffer, ptr, length);
    };
    return {
        'codec.base64url_encode': (ptr, length, output, capacity) => {
            if (length < 0 || length > 65536 || capacity < 0 || capacity > 196608) return -1;
            const encoded = span(ptr, length).toString('base64url');
            if (encoded.length * 2 > capacity) return -1;
            span(output, capacity).write(encoded, 'utf16le');
            return encoded.length;
        },
        'codec.base64url_decode': (ptr, chars, output, capacity) => {
            if (chars < 0 || chars > 65536 || capacity < 0 || capacity > 65536) return -1;
            const encoded = span(ptr, chars * 2)
                .toString('utf16le')
                .replace(/[= \t\r\n]/g, '')
                .replace(/\+/g, '-')
                .replace(/\//g, '_');
            if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) return -1;
            const bytes = Buffer.from(encoded, 'base64url');
            if (bytes.length > capacity) return -1;
            span(output, capacity).set(bytes);
            return bytes.length;
        },
    };
}

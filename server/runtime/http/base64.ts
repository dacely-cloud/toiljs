/** Bounded native base64url for cookies. UTF-16 avoids guest UTF-8 round trips. */
@external('env', 'codec.base64url_encode')
declare function encode(ptr: usize, len: i32, out: usize, cap: i32): i32;
@external('env', 'codec.base64url_decode')
declare function decode(ptr: usize, chars: i32, out: usize, cap: i32): i32;

/** Unpadded RFC 4648 base64url; at most 64 KiB of input. */
export function base64UrlEncode(data: Uint8Array): string {
    if (data.length == 0) return '';
    if (data.length > 65536) throw new Error('base64 input exceeds 64 KiB');
    const length = (data.length / 3) * 4 + (data.length % 3 == 0 ? 0 : data.length % 3 + 1);
    const out = new Uint16Array(length);
    if (encode(data.dataStart, data.length, out.dataStart, out.byteLength) != length) throw new Error('base64 encode failed');
    return String.UTF16.decodeUnsafe(out.dataStart, out.byteLength);
}

/** Accept URL/standard alphabets and ignored padding/ASCII whitespace, as before. */
export function base64UrlDecode(s: string): Uint8Array | null {
    if (s.length > 65536) return null;
    const out = new Uint8Array((s.length * 6) / 8);
    const size = decode(changetype<usize>(s), s.length, out.dataStart, out.length);
    if (size < 0 || size > out.length) return null;
    return size == out.length ? out : out.subarray(0, size);
}

// Imports specific SSR modules (not the runtime index, which pulls in the
// crypto std the as-pect compiler does not ship). These modules are pure
// (escaping + buffer building + linear-memory encode), so they run under
// as-pect; the full `render` export is exercised via the example wasm in
// test/devserver.test.ts.
import { describe, it, expect } from './aspect-shim';
import { escapeHtml, escapeJsonForScript } from '../../server/runtime/ssr/escape';
import { HASH_LEN, HtmlBuilder, SlotKind, SlotValues } from '../../server/runtime/ssr/slots';
import { encodeValues } from '../../server/runtime/ssr/encode';

function bytesToStr(b: Uint8Array): string {
    return String.UTF8.decodeUnsafe(changetype<usize>(b.dataStart), b.length);
}

describe('ssr escape (react-dom byte-identity)', () => {
    it('passes clean text through unchanged', () => {
        expect<string>(escapeHtml('hello world')).toStrictEqual('hello world');
    });

    it('escapes the five React characters with React entities', () => {
        // React uses &#x27; for the apostrophe and &quot; for the quote.
        expect<string>(escapeHtml('<a href="x">A&B\'s</a>')).toStrictEqual(
            '&lt;a href=&quot;x&quot;&gt;A&amp;B&#x27;s&lt;/a&gt;',
        );
    });

    it('escapes ampersand first-class (not double-encoding)', () => {
        expect<string>(escapeHtml('a & b')).toStrictEqual('a &amp; b');
        expect<string>(escapeHtml('&amp;')).toStrictEqual('&amp;amp;');
    });

    it('escapes script-context json delimiters', () => {
        expect<string>(escapeJsonForScript('{"x":"</script>"}')).toStrictEqual(
            '{"x":"\\u003c/script\\u003e"}',
        );
        expect<string>(escapeJsonForScript('{"a":1}')).toStrictEqual('{"a":1}');
    });
});

describe('ssr SlotValues', () => {
    it('escapes text holes and leaves raw holes verbatim', () => {
        const v = new SlotValues(new StaticArray<u8>(HASH_LEN));
        v.setText(0, '<b>');
        v.setRaw(1, '<b>ok</b>');
        expect<i32>(v.slots.length).toBe(2);
        expect<i32>(<i32>v.slots[0].kind).toBe(<i32>SlotKind.TEXT);
        expect<string>(bytesToStr(v.slots[0].bytes)).toStrictEqual('&lt;b&gt;');
        expect<i32>(<i32>v.slots[1].kind).toBe(<i32>SlotKind.RAW);
        expect<string>(bytesToStr(v.slots[1].bytes)).toStrictEqual('<b>ok</b>');
    });

    it('stamps repeat rows by interleaving raw chunks and escaped values', () => {
        const v = new SlotValues(new StaticArray<u8>(HASH_LEN));
        const rows = new HtmlBuilder();
        const items = ['a&b', 'c'];
        for (let i = 0; i < items.length; i++) {
            rows.raw('<li>').text(items[i]).raw('</li>');
        }
        v.setRepeat(2, rows);
        expect<i32>(<i32>v.slots[0].kind).toBe(<i32>SlotKind.REPEAT);
        expect<string>(bytesToStr(v.slots[0].bytes)).toStrictEqual(
            '<li>a&amp;b</li><li>c</li>',
        );
    });
});

describe('ssr encodeValues wire format', () => {
    it('round-trips status, hash, and one text slot', () => {
        const hash = new StaticArray<u8>(HASH_LEN);
        hash[0] = 0xaa;
        hash[31] = 0xbb;
        const v = new SlotValues(hash);
        v.setStatus(200);
        v.setText(7, 'hi');

        const buf = new Uint8Array(128);
        const base = changetype<usize>(buf.dataStart);
        const n = encodeValues(v, base);
        // status(2) + hash(32) + n_headers(2) + n_slots(2) + slot[id(2)+kind(1)+len(4)+"hi"(2)]
        expect<i32>(<i32>n).toBe(2 + 32 + 2 + 2 + 2 + 1 + 4 + 2);

        expect<i32>(<i32>load<u16>(base)).toBe(200); // status
        expect<i32>(<i32>load<u8>(base + 2)).toBe(0xaa); // hash[0]
        expect<i32>(<i32>load<u8>(base + 2 + 31)).toBe(0xbb); // hash[31]
        const afterHash = base + 2 + 32;
        expect<i32>(<i32>load<u16>(afterHash)).toBe(0); // n_headers
        expect<i32>(<i32>load<u16>(afterHash + 2)).toBe(1); // n_slots
        const slot = afterHash + 4;
        expect<i32>(<i32>load<u16>(slot)).toBe(7); // slot_id
        expect<i32>(<i32>load<u8>(slot + 2)).toBe(<i32>SlotKind.TEXT); // kind
        expect<i32>(<i32>load<u32>(slot + 3)).toBe(2); // value_len
        expect<i32>(<i32>load<u8>(slot + 7)).toBe(0x68); // 'h'
        expect<i32>(<i32>load<u8>(slot + 8)).toBe(0x69); // 'i'
    });
});

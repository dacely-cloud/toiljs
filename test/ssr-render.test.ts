/**
 * End-to-end guest render: drive the real ToilScript-compiled `render` export
 * of the SSR example wasm, decode its values envelope, and confirm the guest
 * produces exactly the bytes the Rust host's `decode_values`/`assemble` expects
 * (the same wire format proven on the host side in
 * `toil-backend/src/host/template/assemble.rs`). Closing the loop with the
 * golden byte-identity test (`ssr-template.test.tsx`), this proves the full
 * chain: guest values -> splice -> React-identical HTML.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WasmServerModule } from '../src/devserver/index.js';
import { spliceTemplate } from '../src/compiler/template.js';

const SSR_WASM = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../examples/basic/build/server/ssr.wasm',
);

interface DecodedSlot {
    slotId: number;
    kind: number;
    value: Buffer;
}
interface DecodedValues {
    status: number;
    hash: Buffer;
    headers: [string, string][];
    slots: DecodedSlot[];
}

/** Mirror of the host `decode_values`: parse the guest values envelope. */
function decodeValues(buf: Uint8Array): DecodedValues {
    const b = Buffer.from(buf);
    let o = 0;
    const status = b.readUInt16LE(o);
    o += 2;
    const hash = b.subarray(o, o + 32);
    o += 32;
    const nHeaders = b.readUInt16LE(o);
    o += 2;
    const headers: [string, string][] = [];
    for (let i = 0; i < nHeaders; i++) {
        const nameLen = b.readUInt16LE(o);
        o += 2;
        const valLen = b.readUInt16LE(o);
        o += 2;
        const name = b.toString('utf8', o, o + nameLen);
        o += nameLen;
        const val = b.toString('utf8', o, o + valLen);
        o += valLen;
        headers.push([name, val]);
    }
    const nSlots = b.readUInt16LE(o);
    o += 2;
    const slots: DecodedSlot[] = [];
    for (let i = 0; i < nSlots; i++) {
        const slotId = b.readUInt16LE(o);
        o += 2;
        const kind = b.readUInt8(o);
        o += 1;
        const valueLen = b.readUInt32LE(o);
        o += 4;
        slots.push({ slotId, kind, value: b.subarray(o, o + valueLen) });
        o += valueLen;
    }
    expect(o).toBe(b.length); // no trailing garbage
    return { status, hash, headers, slots };
}

describe.skipIf(!fs.existsSync(SSR_WASM))('edge SSR guest render (real wasm)', () => {
    const load = (): WasmServerModule => {
        const m = new WasmServerModule(SSR_WASM);
        m.refresh();
        return m;
    };
    const render = (m: WasmServerModule, p: string): Uint8Array =>
        m.dispatchRender({
            method: 'GET',
            path: p,
            headers: [['host', 'localhost']],
            body: new Uint8Array(0),
        });

    it('produces a values envelope with the compiled-in hash and escaped holes', () => {
        const d = decodeValues(render(load(), '/hello'));
        expect(d.status).toBe(200);
        // The HASH baked into greeting.slots.ts: bytes 0x00..0x1f.
        expect([...d.hash]).toEqual(Array.from({ length: 32 }, (_, i) => i));

        expect(d.slots.map((s) => `${s.slotId}:${s.kind}`)).toEqual([
            '0:0', // greeting, text
            '1:3', // count, repeat
        ]);
        // Text hole: React-escaped (& -> &amp;, <> -> entities, mirroring escape.ts).
        expect(d.slots[0].value.toString('utf8')).toBe('world &amp; &lt;friends&gt;');
        // Repeat hole: three stamped rows, each escaped.
        expect(d.slots[1].value.toString('utf8')).toBe(
            '<li>a &amp; b</li><li>&lt;c&gt;</li><li>d</li>',
        );
    });

    it('splices into a template exactly (full guest -> host -> HTML chain)', () => {
        const d = decodeValues(render(load(), '/hello'));
        // A template with a greeting hole and a repeat region, holes removed.
        const tmpl = Buffer.from('<h1>Hello </h1><ul></ul>', 'utf8');
        const greetingOffset = '<h1>Hello '.length;
        const repeatOffset = '<h1>Hello </h1><ul>'.length;
        const out = spliceTemplate(tmpl, [
            { offset: greetingOffset, value: Buffer.from(d.slots[0].value) },
            { offset: repeatOffset, value: Buffer.from(d.slots[1].value) },
        ]);
        expect(out.toString('utf8')).toBe(
            '<h1>Hello world &amp; &lt;friends&gt;</h1><ul><li>a &amp; b</li><li>&lt;c&gt;</li><li>d</li></ul>',
        );
    });

    it('fails safe (status 500, zero hash, no slots) for an unmatched path', () => {
        const d = decodeValues(render(load(), '/not-an-ssr-route'));
        expect(d.status).toBe(500);
        expect([...d.hash]).toEqual(Array(32).fill(0));
        expect(d.slots).toHaveLength(0);
    });
});

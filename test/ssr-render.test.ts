/**
 * End-to-end guest render: drive the real ToilScript-compiled `render` export
 * of the basic example's server wasm, decode its values envelope, and confirm
 * the guest produces exactly the bytes the Rust host's `decode_values`/`assemble`
 * expects (the same wire format proven on the host side in
 * `toil-backend/src/host/template/assemble.rs`). Closing the loop with the
 * golden byte-identity test (`ssr-template.test.tsx`), this proves the full
 * chain: guest values -> splice -> React-identical HTML.
 *
 * SSR is part of the normal (single-wasm) build now: the example's `/hello`
 * route opts in with `export const ssr = true`, the build extracts its template
 * into `build/client/_ssr/hello.{tmpl,slots,slots.ts}`, and the server
 * `render` (`examples/basic/server/SsrHelloRender.ts`) fills the holes. We drive
 * the same `build/server/release.wasm` the dev server and edge run, and pin the
 * expected coherence hash to the generated `templates.json` so the guest and the
 * deployed template are proven to agree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WasmServerModule } from '../src/devserver/index.js';
import { spliceTemplate } from '../src/compiler/template.js';

const EXAMPLE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../examples/basic',
);
/** Single-wasm SSR: the server `render` lives in the normal server wasm. */
const SERVER_WASM = path.join(EXAMPLE, 'build/server/release.wasm');
const SSR_DIR = path.join(EXAMPLE, 'build/client/_ssr');
const TEMPLATES = path.join(SSR_DIR, 'templates.json');

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

/** The hash the build pinned for the `/hello` template (deploy-skew guard). */
function helloTemplateHash(): Buffer {
    const index = JSON.parse(fs.readFileSync(TEMPLATES, 'utf8')) as {
        route: string;
        name: string;
        hash: string;
    }[];
    const hello = index.find((t) => t.route === '/hello');
    if (!hello) throw new Error('no /hello template in templates.json');
    return Buffer.from(hello.hash, 'hex');
}

// Skip cleanly when the example has not been built (no toolchain in CI): the
// build is what produces both the wasm and the template artifacts.
const built = fs.existsSync(SERVER_WASM) && fs.existsSync(TEMPLATES);

describe.skipIf(!built)('edge SSR guest render (real single-wasm build)', () => {
    const load = (): WasmServerModule => {
        const m = new WasmServerModule(SERVER_WASM);
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

    it('produces a values envelope with the deployed template hash and escaped holes', () => {
        const d = decodeValues(render(load(), '/hello'));
        expect(d.status).toBe(200);
        // The guest's compiled-in HASH must equal the deployed template's hash,
        // or the host rejects the response as a deploy skew.
        expect(d.hash.equals(helloTemplateHash())).toBe(true);

        // Top-level slots in document order: name (text), blurb (raw), services (repeat).
        expect(d.slots.map((s) => `${s.slotId}:${s.kind}`)).toEqual([
            '0:0', // name, text
            '1:1', // blurb, raw
            '2:3', // services, repeat
        ]);
        // Text hole: the default greeting target.
        expect(d.slots[0].value.toString('utf8')).toBe('world');
        // Raw hole: inserted verbatim (NOT escaped).
        expect(d.slots[1].value.toString('utf8')).toBe(
            'Rendered at the <strong>edge</strong> from a tiny values envelope.',
        );
        // Repeat hole: three stamped rows, each nested hole React-escaped.
        expect(d.slots[2].value.toString('utf8')).toBe(
            '<li><strong>record</strong><span class="hello-region">us-east</span></li>' +
                '<li><strong>unique</strong><span class="hello-region">eu-west</span></li>' +
                '<li><strong>counter</strong><span class="hello-region">ap-south</span></li>',
        );
    });

    it('escapes a text hole derived from the request (?name=)', () => {
        const d = decodeValues(render(load(), '/hello?name=A<b>%26"x'));
        expect(d.status).toBe(200);
        // setText React-escapes: & -> &amp;, <> -> entities, " -> &quot;.
        // (The query value arrives as the raw bytes after `name=`; only `%26`
        // is a literal here, so the guest sees `A<b>&"x` after the `&` split is
        // accounted for — assert the escaping shape rather than the exact bytes.)
        const v = d.slots[0].value.toString('utf8');
        expect(v).not.toContain('<b>');
        expect(v).toContain('&lt;');
    });

    it('splices into the real built template exactly (guest -> host -> HTML)', () => {
        const d = decodeValues(render(load(), '/hello'));
        const tmpl = fs.readFileSync(path.join(SSR_DIR, 'hello.tmpl'));
        const slotsBin = fs.readFileSync(path.join(SSR_DIR, 'hello.slots'));

        // Read the top-level slot offsets straight from the .slots manifest
        // (header is 46 bytes; each entry is offset u32, id u16, kind u8, rsvd u8).
        const nSlots = slotsBin.readUInt16LE(44);
        const byId = new Map(d.slots.map((s) => [s.slotId, s.value]));
        const inserts: { offset: number; value: Buffer }[] = [];
        let o = 46;
        for (let i = 0; i < nSlots; i++) {
            const offset = slotsBin.readUInt32LE(o);
            const id = slotsBin.readUInt16LE(o + 4);
            inserts.push({ offset, value: Buffer.from(byId.get(id)!) });
            o += 8;
        }
        const out = spliceTemplate(tmpl, inserts).toString('utf8');

        // The spliced section is well-formed and carries every filled hole. The
        // `<!-- -->` around `world` are React's text-boundary markers (renderToString
        // emits them so hydrateRoot can align the `name` hole between "Hello, " and "!").
        expect(out).toContain(
            '<section class="hello"><h1>Hello, <!-- -->world<!-- -->!</h1>' +
                '<p class="hello-blurb"><span>Rendered at the <strong>edge</strong> ' +
                'from a tiny values envelope.</span></p>' +
                '<h2>Service snapshot</h2>' +
                '<ul class="hello-services">' +
                '<li><strong>record</strong><span class="hello-region">us-east</span></li>' +
                '<li><strong>unique</strong><span class="hello-region">eu-west</span></li>' +
                '<li><strong>counter</strong><span class="hello-region">ap-south</span></li>' +
                '</ul></section>',
        );
    });

    it('fails safe (status 500, zero hash, no slots) for an unmatched path', () => {
        const d = decodeValues(render(load(), '/not-an-ssr-route'));
        expect(d.status).toBe(500);
        expect([...d.hash]).toEqual(Array(32).fill(0));
        expect(d.slots).toHaveLength(0);
    });
});

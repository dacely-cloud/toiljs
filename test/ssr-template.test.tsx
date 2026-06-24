/**
 * The load-bearing test for edge SSR: prove that the build's
 * template-with-holes + a guest-style stamp reproduces, BYTE FOR BYTE, what
 * React renders for the same data. If this holds, the browser's `hydrateRoot`
 * sees identical markup and hydration is clean.
 *
 * Strategy:
 *   1. Render the component with markers in SENTINEL mode (build) -> strip ->
 *      `.tmpl` + slot records.
 *   2. Render the SAME component with REAL data normally -> `expected`.
 *   3. Simulate the guest: stamp each hole's value (React-escaped text, raw
 *      verbatim, repeat = stamp the captured row template per real item) and
 *      splice into the `.tmpl`.
 *   4. assert stamped === expected.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Hole, Island, RawHtml, Repeat, attr, __setSsrBuild } from '../src/client/ssr/markers';
import { LoaderDataContext, useLoaderData } from '../src/client/routing/loader';
import {
    extractRouteTemplate,
    injectIntoShell,
    routeTemplateName,
    writeTemplateArtifacts,
} from '../src/compiler/template-build';
import {
    assignSlotIds,
    coherenceHash,
    encodeSlots,
    extractFromHtml,
    kindByte,
    reactEscapeHtml,
    spliceTemplate,
    type SlotRecord,
} from '../src/compiler/template';
import { generateSlotsModule } from '../src/compiler/ssr-codegen';

interface Post {
    title: string;
}
interface ProfileData {
    username: string;
    bioHtml: string;
    posts: Post[];
}

function Profile({ d }: { d: ProfileData }): React.ReactElement {
    return (
        <main>
            <h1>
                @<Hole id="username">{d.username}</Hole>
            </h1>
            <RawHtml id="bio" html={d.bioHtml} />
            <ul>
                <Repeat id="posts" each={d.posts}>
                    {(p: Post) => (
                        <li>
                            <Hole id="title">{p.title}</Hole>
                        </li>
                    )}
                </Repeat>
            </ul>
        </main>
    );
}

/** Render under the build sentinel pass (always restores the flag). */
function renderBuild(el: React.ReactElement): string {
    __setSsrBuild(true);
    try {
        return renderToStaticMarkup(el);
    } finally {
        __setSsrBuild(false);
    }
}

/** Simulate the guest: produce the bytes for one top-level slot from real data. */
function stampSlot(slot: SlotRecord, d: ProfileData): Buffer {
    if (slot.kind === 'text' && slot.id === 'username') {
        return Buffer.from(reactEscapeHtml(d.username), 'utf8');
    }
    if (slot.kind === 'raw' && slot.id === 'bio') {
        return Buffer.from(d.bioHtml, 'utf8');
    }
    if (slot.kind === 'repeat' && slot.id === 'posts') {
        const rowTmpl = slot.rowTemplate!;
        const rows: Buffer[] = d.posts.map((p) =>
            spliceTemplate(
                rowTmpl,
                slot.rowSlots!.map((rs) => ({
                    offset: rs.offset,
                    value: Buffer.from(reactEscapeHtml(p.title), 'utf8'),
                })),
            ),
        );
        return Buffer.concat(rows);
    }
    throw new Error(`unexpected slot ${slot.id}/${slot.kind}`);
}

function assemble(tmpl: Buffer, slots: SlotRecord[], d: ProfileData): Buffer {
    return spliceTemplate(
        tmpl,
        slots.map((s) => ({ offset: s.offset, value: stampSlot(s, d) })),
    );
}

describe('ssr template extraction', () => {
    it('strips sentinels and records hole offsets', () => {
        const sample: ProfileData = {
            username: 'ada',
            bioHtml: '<em>hi</em>',
            posts: [{ title: 'first' }],
        };
        const { tmpl, slots } = extractFromHtml(renderBuild(<Profile d={sample} />));

        // Static scaffold = React's own output, holes removed. The <div> from
        // RawHtml's wrapper is present and empty; the <ul> is empty.
        expect(tmpl.toString('utf8')).toBe('<main><h1>@</h1><div></div><ul></ul></main>');

        expect(slots.map((s) => `${s.id}:${s.kind}`)).toEqual([
            'username:text',
            'bio:raw',
            'posts:repeat',
        ]);
        // Offsets are ascending and land at the right spots.
        const t = tmpl.toString('utf8');
        expect(t.slice(0, slots[0].offset)).toBe('<main><h1>@');
        expect(slots[1].offset).toBe(t.indexOf('<div>') + '<div>'.length);
        expect(slots[2].offset).toBe(t.indexOf('<ul>') + '<ul>'.length);

        // Repeat captured the single-row sub-template + its nested hole.
        const posts = slots[2];
        expect(posts.rowTemplate!.toString('utf8')).toBe('<li></li>');
        expect(posts.rowSlots!.map((r) => `${r.id}:${r.kind}`)).toEqual(['title:text']);
        expect(posts.rowSlots![0].offset).toBe('<li>'.length);
    });

    it('collapses Island to nothing server-side', () => {
        const html = renderBuild(
            <div>
                <Island>
                    <span>client only</span>
                </Island>
            </div>,
        );
        expect(extractFromHtml(html).tmpl.toString('utf8')).toBe('<div></div>');
    });
});

describe('ssr GOLDEN byte-identity (template+stamp === React render)', () => {
    const sample: ProfileData = {
        username: 'ada',
        bioHtml: '<em>sample</em>',
        posts: [{ title: 'sample' }],
    };

    function check(real: ProfileData): void {
        const { tmpl, slots } = extractFromHtml(renderBuild(<Profile d={sample} />));
        const stamped = assemble(tmpl, slots, real);
        const expected = renderToStaticMarkup(<Profile d={real} />);
        expect(stamped.toString('utf8')).toBe(expected);
    }

    it('matches for plain data', () => {
        check({
            username: 'grace',
            bioHtml: '<strong>Rear Admiral</strong>',
            posts: [{ title: 'COBOL' }, { title: 'the bug' }, { title: 'compilers' }],
        });
    });

    it('matches when values need React escaping (the &#x27; / &quot; cases)', () => {
        check({
            username: `A<b>&"'x`,
            bioHtml: '<em>raw & <kept></em>', // raw: NOT escaped, verbatim
            posts: [{ title: 'a & b' }, { title: '<script>' }, { title: `it's "ok"` }],
        });
    });

    it('matches for an empty list (zero rows)', () => {
        check({ username: 'zero', bioHtml: '<i/>', posts: [] });
    });

    it('matches for a single row', () => {
        check({ username: 'one', bioHtml: 'x', posts: [{ title: 'only' }] });
    });
});

describe('ssr .slots binary manifest', () => {
    it('encodes the documented layout and round-trips offsets/kinds', () => {
        const sample: ProfileData = {
            username: 'ada',
            bioHtml: '<em>x</em>',
            posts: [{ title: 't' }],
        };
        const { tmpl, slots } = extractFromHtml(renderBuild(<Profile d={sample} />));
        const ids = assignSlotIds(slots);
        const hash = coherenceHash(tmpl, slots);
        const buf = encodeSlots(tmpl.length, hash, slots, ids);

        // Header: magic "TSLT", version 1, flags 0, tmpl_len, hash, n_slots.
        expect(buf.subarray(0, 4).toString('ascii')).toBe('TSLT');
        expect(buf.readUInt16LE(4)).toBe(1);
        expect(buf.readUInt16LE(6)).toBe(0);
        expect(buf.readUInt32LE(8)).toBe(tmpl.length);
        expect(buf.subarray(12, 44).equals(hash)).toBe(true);
        expect(buf.readUInt16LE(44)).toBe(slots.length);

        // Slot entries: offset u32, slot_id u16, kind u8, reserved u8.
        let o = 46;
        slots.forEach((s, i) => {
            expect(buf.readUInt32LE(o)).toBe(s.offset);
            expect(buf.readUInt16LE(o + 4)).toBe(ids.get(s.id));
            expect(buf.readUInt8(o + 6)).toBe(kindByte(s.kind));
            expect(buf.readUInt8(o + 7)).toBe(0);
            expect(ids.get(s.id)).toBe(i); // document-order numbering
            o += 8;
        });
        expect(o).toBe(buf.length);
    });

    it('coherence hash changes when the template changes', () => {
        const a = extractFromHtml(
            renderBuild(<Profile d={{ username: 'a', bioHtml: 'x', posts: [{ title: 't' }] }} />),
        );
        const h1 = coherenceHash(a.tmpl, a.slots);
        const h2 = coherenceHash(Buffer.concat([a.tmpl, Buffer.from('!')]), a.slots);
        expect(h1.equals(h2)).toBe(false);
    });
});

describe('ssr guest codegen (Slot enum + HASH)', () => {
    const sample: ProfileData = {
        username: 'ada',
        bioHtml: '<em>x</em>',
        posts: [{ title: 't' }],
    };

    it('emits a Slot enum matching the .slots numbering and the 32-byte HASH', () => {
        const { tmpl, slots } = extractFromHtml(renderBuild(<Profile d={sample} />));
        const ids = assignSlotIds(slots);
        const hash = coherenceHash(tmpl, slots);
        const mod = generateSlotsModule('u_name', slots, hash);

        // Enum members use the SAME ids the host .slots carries.
        expect(mod).toContain('export enum Slot {');
        expect(mod).toContain(`username = ${ids.get('username')},`);
        expect(mod).toContain(`bio = ${ids.get('bio')},`);
        expect(mod).toContain(`posts = ${ids.get('posts')},`);
        // HASH literal has exactly 32 bytes.
        const arr = mod.match(/HASH: StaticArray<u8> = \[([^\]]*)\]/)![1];
        expect(arr.split(',').filter((s) => s.trim().length > 0)).toHaveLength(32);
        expect(mod).toContain(`0x${hash[0].toString(16).padStart(2, '0')}`);
    });

    it('rejects a hole id that is not a valid identifier', () => {
        const bad: SlotRecord[] = [{ id: 'has-dash', kind: 'text', offset: 0 }];
        expect(() => generateSlotsModule('r', bad, Buffer.alloc(32))).toThrow(/not a valid identifier/);
    });
});

describe('ssr attribute holes (attr())', () => {
    it('is transparent in the browser and a sentinel under the build extractor', () => {
        // Browser (default): passes the value through unchanged.
        expect(attr('link', '/u/ada')).toBe('/u/ada');
        // Build: emits a PUA sentinel token (start codepoint U+E000) carrying the id.
        __setSsrBuild(true);
        try {
            const tok = attr('link', '/u/ada');
            expect(tok).not.toBe('/u/ada');
            expect(tok.charCodeAt(0)).toBe(0xe000);
            expect(tok).toContain('link');
        } finally {
            __setSsrBuild(false);
        }
    });

    it('extracts an attr slot whose guest stamp reproduces React attribute output byte-for-byte', () => {
        // Render with the attr() hole in an attribute position, in build mode.
        __setSsrBuild(true);
        let built: string;
        try {
            built = renderToStaticMarkup(<a href={attr('link', 'IGNORED_AT_BUILD')}>x</a>);
        } finally {
            __setSsrBuild(false);
        }
        const { tmpl, slots } = extractFromHtml(built);
        expect(slots).toHaveLength(1);
        expect(slots[0]).toMatchObject({ id: 'link', kind: 'attr' });
        expect(kindByte(slots[0].kind)).toBe(2);
        // The .tmpl carries the attribute with the hole stripped to an empty value.
        expect(tmpl.toString('utf8')).toBe('<a href="">x</a>');

        // Guest stamp: setAttr React-escapes (identical to text); splice at the offset.
        const value = '/u/ada?q="a"&b<c>';
        const stamped = spliceTemplate(tmpl, [
            { offset: slots[0].offset, value: Buffer.from(reactEscapeHtml(value), 'utf8') },
        ]).toString('utf8');

        // Byte-identical to what React renders for the same attribute value (clean hydration).
        expect(stamped).toBe(renderToStaticMarkup(<a href={value}>x</a>));
    });
});

describe('ssr build orchestration', () => {
    const SHELL =
        '<!doctype html><html><head><title>t</title></head><body><div id="root"></div>' +
        '<script type="module" src="/assets/app-abc123.js"></script></body></html>';

    // A page that reads its data from the loader context (exercises the provider
    // path), wrapped in a simple SSR-safe layout.
    function ProfilePage(): React.ReactElement {
        const d = useLoaderData<ProfileData>();
        return <Profile d={d} />;
    }
    function Layout({ children }: { children?: React.ReactNode }): React.ReactElement {
        return <div className="app">{children}</div>;
    }

    const sample: ProfileData = {
        username: 'ada',
        bioHtml: '<em>x</em>',
        posts: [{ title: 't' }],
    };

    it('sanitizes route patterns into file-safe names', () => {
        expect(routeTemplateName('/u/:name')).toBe('u_name');
        expect(routeTemplateName('/')).toBe('index');
        expect(routeTemplateName('/blog/[id]')).toBe('blog_id');
    });

    it('injects rendered route HTML into the shell #root with the SSR marker', () => {
        const out = injectIntoShell(SHELL, '<main>hi</main>');
        expect(out).toContain('<div id="root"><main>hi</main></div>');
        expect(out).toContain('<template id="__toil_ssr"></template>');
        // the hashed script tag is preserved (so hydration boots)
        expect(out).toContain('/assets/app-abc123.js');
    });

    it('renders a route (page + layout + loader data) to template artifacts and writes them', () => {
        const art = extractRouteTemplate({
            name: 'profile',
            Page: ProfilePage,
            layouts: [Layout],
            loaderData: sample,
            loaderContext: LoaderDataContext,
            setSsrBuild: __setSsrBuild,
            shell: SHELL,
        });

        const tmpl = art.tmpl.toString('utf8');
        // Full document with the layout + page scaffold spliced into #root, holes removed.
        // The `<!-- -->` after `@` is React's text-boundary marker (renderToString emits
        // it so hydrateRoot can align the `username` hole); the hole text itself is stripped.
        expect(tmpl).toContain(
            '<div id="root"><div class="app"><main><h1>@<!-- --></h1><div></div><ul></ul></main></div></div>',
        );
        expect(tmpl).toContain('<template id="__toil_ssr"></template>');
        expect(tmpl).toContain('/assets/app-abc123.js'); // bootstrap script preserved
        expect(art.slotCount).toBe(3); // username, bio, posts
        expect(art.hash).toHaveLength(32);

        // The generated AS Slot module names every hole.
        expect(art.slotsModule).toContain('export enum Slot {');
        for (const id of ['username', 'bio', 'posts']) expect(art.slotsModule).toContain(`${id} =`);

        // Write to disk and read back; the .slots header is well-formed and the
        // tmpl_len in it matches the .tmpl byte length (the host's first check).
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-ssr-'));
        try {
            writeTemplateArtifacts(dir, art);
            const tmplFile = fs.readFileSync(path.join(dir, 'profile.tmpl'));
            const slotsFile = fs.readFileSync(path.join(dir, 'profile.slots'));
            const modFile = fs.readFileSync(path.join(dir, 'profile.slots.ts'), 'utf8');

            expect(tmplFile.equals(art.tmpl)).toBe(true);
            expect(slotsFile.subarray(0, 4).toString('ascii')).toBe('TSLT');
            expect(slotsFile.readUInt16LE(4)).toBe(1); // version
            expect(slotsFile.readUInt32LE(8)).toBe(tmplFile.length); // tmpl_len matches .tmpl
            expect(slotsFile.subarray(12, 44).equals(art.hash)).toBe(true);
            expect(slotsFile.readUInt16LE(44)).toBe(3); // n_slots
            expect(modFile).toContain('export const HASH: StaticArray<u8>');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

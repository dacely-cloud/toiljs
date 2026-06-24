// @vitest-environment jsdom
/**
 * Real-hydration test: drive the actual build (`extractRouteTemplate`, which now
 * renders with `renderToString`) -> splice -> `hydrateRoot` path in jsdom and
 * assert there is NO hydration mismatch and the content is present. This is the
 * failure users hit ("server rendered HTML didn't match the client"), and it
 * covers the three things that broke it:
 *   - "text + hole + text" (`Hello, <Hole>{name}</Hole>!`): needs the `<!-- -->`
 *     text-boundary markers `renderToString` emits.
 *   - an `<img>`, whose React 19 auto-preload `<link>` must be kept OUT of `#root`.
 *   - an `<Island>`, which must be empty on the first (hydration) render.
 */
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { Hole, Island, RawHtml, __setSsrBuild } from '../src/client/ssr/markers';
import { extractRouteTemplate } from '../src/compiler/template-build';
import { reactEscapeHtml, spliceTemplate } from '../src/compiler/template';

const NAME = 'world';
const BLURB = 'Rendered at the <strong>edge</strong>.';

function Page(): React.ReactElement {
    return (
        <main>
            <img src="/images/logo.svg" alt="logo" width={28} height={28} />
            <h1>
                Hello, <Hole id="name">{NAME}</Hole>!
            </h1>
            <p>
                <RawHtml id="blurb" html={BLURB} as="span" />
            </p>
            <Island>
                <span className="isle">island-only</span>
            </Island>
        </main>
    );
}

const SHELL =
    '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

/** Build the template (renderToString + strip), splice per-slot values, return #root inner HTML. */
function serverRootHtml(): string {
    const art = extractRouteTemplate({
        name: 'hyd',
        Page,
        layouts: [],
        loaderData: null,
        loaderContext: null,
        setSsrBuild: __setSsrBuild,
        shell: SHELL,
    });
    const valueFor: Record<number, Buffer> = {
        0: Buffer.from(reactEscapeHtml(NAME), 'utf8'), // name (text)
        1: Buffer.from(BLURB, 'utf8'), // blurb (raw)
    };
    const nSlots = art.slotsBin.readUInt16LE(44);
    const inserts: { offset: number; value: Buffer }[] = [];
    let o = 46;
    for (let i = 0; i < nSlots; i++) {
        inserts.push({ offset: art.slotsBin.readUInt32LE(o), value: valueFor[art.slotsBin.readUInt16LE(o + 4)] });
        o += 8;
    }
    const full = spliceTemplate(art.tmpl, inserts).toString('utf8');
    const m = /<div id="root">([\s\S]*?)<\/div><template id="__toil_ssr">/.exec(full);
    if (!m) throw new Error('could not isolate #root');
    return m[1];
}

describe('ssr hydration (real hydrateRoot, no mismatch)', () => {
    it('hydrates the spliced server markup cleanly and reveals the island after mount', async () => {
        const rootInner = serverRootHtml();
        expect(rootInner).not.toContain('rel="preload"'); // preload hoisted to <head>, not #root
        expect(rootInner).not.toContain('island-only'); // island empty server-side
        expect(rootInner).toContain('Hello, '); // text hole filled
        expect(rootInner).toContain('<strong>edge</strong>'); // raw hole verbatim

        document.body.innerHTML = `<div id="root">${rootInner}</div>`;
        const rootEl = document.getElementById('root')!;

        const recoverable: string[] = [];
        const consoleErrors: string[] = [];
        const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
            consoleErrors.push(a.map(String).join(' '));
        });
        try {
            await act(async () => {
                hydrateRoot(rootEl, <Page />, {
                    onRecoverableError: (e) => recoverable.push(String(e)),
                });
            });
        } finally {
            spy.mockRestore();
        }

        const noise = /hydrat|did not match|server rendered|didn't match/i;
        expect(recoverable.filter((e) => noise.test(e))).toEqual([]);
        expect(consoleErrors.filter((e) => noise.test(e))).toEqual([]);

        // Content survived hydration (not regenerated/blanked); the island revealed after mount.
        expect(rootEl.querySelector('h1')?.textContent).toBe('Hello, world!');
        expect(rootEl.querySelector('.isle')?.textContent).toBe('island-only');
        expect(rootEl.querySelector('img')?.getAttribute('src')).toBe('/images/logo.svg');
    });
});

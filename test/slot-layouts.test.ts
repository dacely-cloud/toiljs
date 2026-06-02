import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/compiler/config';
import { generate } from '../src/compiler/generate';

const roots: string[] = [];
function project(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-gen-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return root;
}
afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const COMP = `export default function C() { return null; }\n`;
const LAYOUT = `export default function L({ children }) { return children; }\n`;
const HTML = `<!doctype html><html><head></head><body><div id="root"></div></body></html>\n`;

describe('generate: parallel-slot layout chains', () => {
    it('keeps the parent layout on the full-page route but drops it from the @slot route', async () => {
        const root = project({
            'client/public/index.html': HTML,
            'client/routes/gallery/layout.tsx': LAYOUT,
            'client/routes/gallery/index.tsx': COMP,
            'client/routes/gallery/photo/[id].tsx': COMP,
            'client/routes/gallery/@modal/(.)photo/[id].tsx': COMP,
        });
        const cfg = await loadConfig({ root });
        generate(cfg);
        const lines = fs.readFileSync(path.join(cfg.toilDir, 'routes.ts'), 'utf8').split('\n');

        // The normal full-page route is wrapped by gallery/layout.
        const mainLine = lines.find((l) => l.includes('photo/[id]') && !l.includes('@modal'));
        expect(mainLine).toMatch(/gallery\/layout/);

        // The intercepting @modal slot route is rendered INTO gallery/layout's <Slot>, so it must not
        // re-include that layout (doing so recurses, the slot rendering itself forever).
        const slotLine = lines.find((l) => l.includes('@modal'));
        expect(slotLine).toContain('intercept: true');
        expect(slotLine).toMatch(/layouts: \[\]/);
        expect(slotLine).not.toMatch(/gallery\/layout/);
    });

    it('still applies a layout placed inside the @slot subtree', async () => {
        const root = project({
            'client/public/index.html': HTML,
            'client/routes/gallery/layout.tsx': LAYOUT,
            'client/routes/gallery/@modal/layout.tsx': LAYOUT,
            'client/routes/gallery/@modal/(.)photo/[id].tsx': COMP,
        });
        const cfg = await loadConfig({ root });
        generate(cfg);
        const lines = fs.readFileSync(path.join(cfg.toilDir, 'routes.ts'), 'utf8').split('\n');
        const slotLine = lines.find((l) => l.includes('@modal/(.)photo'));
        // The slot's own layout (inside @modal) applies; the parent gallery layout does not.
        expect(slotLine).toMatch(/@modal\/layout/);
        expect(slotLine).not.toMatch(/gallery\/layout/);
    });
});

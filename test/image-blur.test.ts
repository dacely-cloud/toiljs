import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { imageBlurPlugin } from '../src/compiler/image-blur';

/** Call the plugin's `load` hook directly (it uses no Rollup `this` context). */
function loadHook(): (id: string) => Promise<string | undefined> {
    const plugin = imageBlurPlugin();
    return plugin.load as unknown as (id: string) => Promise<string | undefined>;
}

describe('imageBlurPlugin', () => {
    it('emits a { src, width, height, blurDataURL } module for a ?toil image import', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-blur-'));
        const file = path.join(dir, 'pic.png');
        await sharp({
            create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 100, b: 50 } },
        })
            .png()
            .toFile(file);
        try {
            const load = loadHook();
            const out = await load(`${file}?toil`);
            expect(typeof out).toBe('string');
            // re-imports the bare asset for src (so Vite/imagetools still optimize + hash it)
            expect(out).toContain(`import src from ${JSON.stringify(file)}`);
            // carries the intrinsic size for the aspect-ratio
            expect(out).toContain('width: 40');
            expect(out).toContain('height: 30');
            // a real inlined LQIP, not a placeholder string
            expect(out).toContain('blurDataURL: "data:image/webp;base64,');
            const b64 = /base64,([^"]+)"/.exec(out as string)?.[1] ?? '';
            expect(b64.length).toBeGreaterThan(20);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('ignores imports without the ?toil flag', async () => {
        const load = loadHook();
        expect(await load('/some/pic.png')).toBeUndefined();
        expect(await load('/some/pic.png?w=400')).toBeUndefined();
        // non-raster ?toil (e.g. svg) is skipped too
        expect(await load('/some/icon.svg?toil')).toBeUndefined();
    });
});

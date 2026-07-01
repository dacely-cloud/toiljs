import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { injectSri } from '../src/compiler/sri';

describe('injectSri', () => {
    const dirs: string[] = [];
    function outDir(files: Record<string, string>): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-sri-'));
        dirs.push(root);
        for (const [rel, body] of Object.entries(files)) {
            const full = path.join(root, rel);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, body);
        }
        return root;
    }
    afterEach(() => {
        for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    it('adds sha384 integrity + crossorigin to a local module script', () => {
        const root = outDir({ 'assets/index-abc.js': 'console.log(1)' });
        const html = injectSri(
            '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
            root,
            '/',
        );
        expect(html).toMatch(/integrity="sha384-[A-Za-z0-9+/]+=*"/);
        // Vite already put crossorigin on the tag, so it isn't duplicated.
        expect(html.match(/crossorigin/g)?.length).toBe(1);
    });

    it('adds integrity to stylesheets and modulepreload, plus a missing crossorigin', () => {
        const root = outDir({
            'assets/a.css': 'body{}',
            'assets/chunk.js': 'export default 1',
        });
        const css = injectSri('<link rel="stylesheet" href="/assets/a.css">', root, '/');
        expect(css).toMatch(/integrity="sha384-/);
        expect(css).toContain('crossorigin="anonymous"');
        const pre = injectSri('<link rel="modulepreload" href="/assets/chunk.js" />', root, '/');
        expect(pre).toMatch(/integrity="sha384-/);
        expect(pre.trimEnd().endsWith('/>')).toBe(true); // self-closing preserved
    });

    it('leaves external URLs, inline scripts, icons, and missing files alone', () => {
        const root = outDir({ 'assets/x.js': 'x' });
        const external = '<script src="https://cdn.example.com/a.js"></script>';
        expect(injectSri(external, root, '/')).toBe(external);
        const inline = '<script type="application/json">{"a":1}</script>';
        expect(injectSri(inline, root, '/')).toBe(inline);
        const icon = '<link rel="icon" href="/favicon.ico">';
        expect(injectSri(icon, root, '/')).toBe(icon);
        const missing = '<script src="/assets/gone.js"></script>';
        expect(injectSri(missing, root, '/')).toBe(missing); // unreadable -> skipped, not crashed
    });

    it('does not double-tag a script that already has integrity', () => {
        const root = outDir({ 'assets/x.js': 'x' });
        const already = '<script src="/assets/x.js" integrity="sha384-existing"></script>';
        expect(injectSri(already, root, '/')).toBe(already);
    });

    it('honors a non-root base', () => {
        const root = outDir({ 'assets/x.js': 'x' });
        const html = injectSri('<script src="/sub/assets/x.js"></script>', root, '/sub/');
        expect(html).toMatch(/integrity="sha384-/);
    });
});

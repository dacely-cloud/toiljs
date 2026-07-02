import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildImportMapIntegrity, injectImportMap, injectSri } from '../src/compiler/sri';

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

describe('buildImportMapIntegrity + injectImportMap (module-graph coverage)', () => {
    const dirs: string[] = [];
    function outDir(files: Record<string, string>): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-srimap-'));
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

    it('maps every emitted chunk (incl. ones no HTML tag references) with sha384', () => {
        const root = outDir({
            'assets/index-abc.js': 'entry',
            'assets/layout-def.js': 'lazy route chunk', // loaded via import(), never in a tag
            'assets/react-ghi.js': 'vendor',
            'assets/style-x.css': 'body{}', // not a module: excluded
        });
        const tag = buildImportMapIntegrity(root, '/');
        expect(tag).not.toBeNull();
        const map = JSON.parse((tag as string).replace(/^<script type="importmap">|<\/script>$/g, ''));
        expect(Object.keys(map.integrity).sort()).toEqual([
            '/assets/index-abc.js',
            '/assets/layout-def.js',
            '/assets/react-ghi.js',
        ]);
        for (const v of Object.values(map.integrity)) expect(v).toMatch(/^sha384-/);
    });

    it('prefixes a non-root base and returns null with no chunks', () => {
        const root = outDir({ 'assets/a.js': 'a' });
        const tag = buildImportMapIntegrity(root, '/sub/') as string;
        expect(tag).toContain('"/sub/assets/a.js"');
        const empty = outDir({ 'index.html': '<html></html>' });
        expect(buildImportMapIntegrity(empty, '/')).toBeNull();
    });

    it('injects after <head>, before any module script, and is idempotent', () => {
        const html = '<html><head><meta x></head><body><script type="module" src="/a.js"></script></body></html>';
        const tag = '<script type="importmap">{"integrity":{"/assets/a.js":"sha384-zzz"}}</script>';
        const out = injectImportMap(html, tag);
        expect(out.indexOf('importmap')).toBeGreaterThan(out.indexOf('<head>'));
        expect(out.indexOf('importmap')).toBeLessThan(out.indexOf('type="module"'));
        // Idempotent: a second pass does not duplicate the map.
        expect(injectImportMap(out, tag)).toBe(out);
        // No <head>: falls back to before the first <script>.
        const headless = injectImportMap('<script src="/x.js"></script>', tag);
        expect(headless.indexOf('importmap')).toBeLessThan(headless.indexOf('src="/x.js"'));
    });
});

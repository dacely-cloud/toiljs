import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { exportsTrue } from '../src/compiler/prerender';
import { patternToBracketFile, staticSectionPattern } from '../src/compiler/routes';
import { resolveDynamicFile } from '../src/devserver/http/runtime';

describe('patternToBracketFile', () => {
    it('inverts URL patterns back to on-disk bracket filenames', () => {
        expect(patternToBracketFile('/blog/:id')).toBe('blog/[id].html');
        expect(patternToBracketFile('/docs/*slug')).toBe('docs/[...slug].html');
        expect(patternToBracketFile('/docs/**slug')).toBe('docs/[[...slug]].html');
        expect(patternToBracketFile('/:category/:id')).toBe('[category]/[id].html');
        expect(patternToBracketFile('/gallery/photo/:id')).toBe('gallery/photo/[id].html');
    });
});

describe('staticSectionPattern', () => {
    it('strips dynamic segments to the static section (for the template canonical)', () => {
        expect(staticSectionPattern('/blog/:id')).toBe('/blog');
        expect(staticSectionPattern('/docs/*slug')).toBe('/docs');
        expect(staticSectionPattern('/:category/:id')).toBe('/');
        expect(staticSectionPattern('/gallery/photo/:id')).toBe('/gallery/photo');
    });
});

describe('exportsTrue (edge-SSR opt-in detection)', () => {
    const files: string[] = [];
    function tmp(source: string): string {
        const file = path.join(os.tmpdir(), `toil-ssrflag-${String(files.length)}-${process.pid}.tsx`);
        fs.writeFileSync(file, source);
        files.push(file);
        return file;
    }
    afterEach(() => {
        for (const f of files.splice(0)) fs.rmSync(f, { force: true });
    });

    it('detects `export const ssr = true`', () => {
        expect(exportsTrue(ts, tmp(`export const ssr = true;\nexport default () => null;\n`), 'ssr')).toBe(
            true,
        );
    });
    it('is false for ssr=false, a non-literal, or an absent export', () => {
        expect(exportsTrue(ts, tmp(`export const ssr = false;\n`), 'ssr')).toBe(false);
        expect(exportsTrue(ts, tmp(`const ssr = true;\n`), 'ssr')).toBe(false); // not exported
        expect(exportsTrue(ts, tmp(`export const other = true;\n`), 'ssr')).toBe(false);
    });
});

describe('resolveDynamicFile (self-host bracket routing, mirrors the edge)', () => {
    const roots: string[] = [];
    function siteRoot(): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-dyn-'));
        roots.push(root);
        return root;
    }
    function write(root: string, rel: string, body = '<html></html>'): void {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    afterEach(() => {
        for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    it('serves a single-segment [id].html for a matching URL, one segment only', () => {
        const root = siteRoot();
        write(root, 'blog/[id].html', 'blog-shell');
        expect(resolveDynamicFile(root, '/blog/hello')).toBe(path.join(root, 'blog/[id].html'));
        expect(resolveDynamicFile(root, '/blog/a/b')).toBeNull();
    });

    it('serves a required catch-all for 1+ segments but not zero', () => {
        const root = siteRoot();
        write(root, 'docs/[...slug].html', 'docs');
        expect(resolveDynamicFile(root, '/docs/a')).toBe(path.join(root, 'docs/[...slug].html'));
        expect(resolveDynamicFile(root, '/docs/a/b/c')).toBe(path.join(root, 'docs/[...slug].html'));
        expect(resolveDynamicFile(root, '/docs')).toBeNull();
        // Parity with the client router + edge: a literal `index.html` segment is a slug (matches
        // the catch-all), while a bare `/docs/` is zero trailing segments (no required-catch-all match).
        expect(resolveDynamicFile(root, '/docs/index.html')).toBe(
            path.join(root, 'docs/[...slug].html'),
        );
        expect(resolveDynamicFile(root, '/docs/')).toBeNull();
    });

    it('serves an optional catch-all for 0+ segments', () => {
        const root = siteRoot();
        write(root, 'files/[[...slug]].html', 'files');
        expect(resolveDynamicFile(root, '/files')).toBe(path.join(root, 'files/[[...slug]].html'));
        expect(resolveDynamicFile(root, '/files/a/b')).toBe(path.join(root, 'files/[[...slug]].html'));
    });

    it('prefers single over catch-all for one segment, catch-all for deeper', () => {
        const root = siteRoot();
        write(root, 'shop/[id].html', 'one');
        write(root, 'shop/[...rest].html', 'many');
        expect(fs.readFileSync(resolveDynamicFile(root, '/shop/x') as string, 'utf8')).toBe('one');
        expect(fs.readFileSync(resolveDynamicFile(root, '/shop/x/y') as string, 'utf8')).toBe('many');
    });

    it('prefers a real static subdirectory over a dynamic sibling', () => {
        const root = siteRoot();
        write(root, 'blog/[id].html', 'template');
        write(root, 'blog/about/deep/[id].html', 'deep');
        // /blog/about/deep/7 descends the real dirs to the deep template, not blog/[id].html.
        expect(resolveDynamicFile(root, '/blog/about/deep/7')).toBe(
            path.join(root, 'blog/about/deep/[id].html'),
        );
    });

    it('resolves a nested bracket directory', () => {
        const root = siteRoot();
        write(root, '[category]/[id].html', 'cat');
        expect(resolveDynamicFile(root, '/electronics/9')).toBe(
            path.join(root, '[category]/[id].html'),
        );
        expect(resolveDynamicFile(root, '/electronics')).toBeNull();
    });

    it('returns null when no bracket template exists', () => {
        const root = siteRoot();
        write(root, 'about/index.html', 'about');
        expect(resolveDynamicFile(root, '/blog/foo')).toBeNull();
        expect(resolveDynamicFile(root, '/x/y/z')).toBeNull();
    });
});

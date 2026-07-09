import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    extractStaticMetadata,
    loadTypeScript,
    loadTypeScriptSync,
} from '../src/compiler/prerender';

const written: string[] = [];
function tmp(source: string): string {
    const file = path.join(
        os.tmpdir(),
        `toil-prerender-${String(written.length)}-${process.pid}.tsx`,
    );
    fs.writeFileSync(file, source);
    written.push(file);
    return file;
}
afterEach(() => {
    for (const f of written.splice(0)) fs.rmSync(f, { force: true });
});

describe('extractStaticMetadata', () => {
    it('extracts a static metadata object literal (nested objects/arrays)', () => {
        const file = tmp(
            `export const metadata = { title: 'X', keywords: ['a', 'b'], openGraph: { type: 'website' } };\n` +
                `export default function P() { return null; }\n`,
        );
        expect(extractStaticMetadata(ts, file)).toEqual({
            title: 'X',
            keywords: ['a', 'b'],
            openGraph: { type: 'website' },
        });
    });

    it('returns null when there is no static metadata export', () => {
        expect(
            extractStaticMetadata(ts, tmp(`export default function P() { return null; }\n`)),
        ).toBeNull();
        // generateMetadata (a function) is not a static object literal → not extracted.
        expect(
            extractStaticMetadata(
                ts,
                tmp(`export const generateMetadata = () => ({ title: 'X' });\n`),
            ),
        ).toBeNull();
    });

    it('skips computed/non-literal properties but keeps the static ones', () => {
        const file = tmp(`const x = foo();\nexport const metadata = { title: 'X', dyn: x };\n`);
        expect(extractStaticMetadata(ts, file)).toEqual({ title: 'X' });
    });
});

/**
 * Builds a throwaway project root whose resolvable `typescript` is `main`-ed at a module exporting
 * only `version` — the shape TypeScript 7 ships, having moved the compiler API to
 * `typescript/unstable/*`. Resolution succeeds, so a truthy check can't tell it apart from a usable
 * compiler; only probing the API can.
 */
function rootWithApiLessTypeScript(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `toil-ts7-${process.pid}-`));
    dirs.push(root);
    const pkgDir = path.join(root, 'node_modules', 'typescript');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}');
    fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        '{"name":"typescript","version":"7.0.2","main":"./version.cjs"}',
    );
    fs.writeFileSync(
        path.join(pkgDir, 'version.cjs'),
        `module.exports = { version: '7.0.2', versionMajorMinor: '7.0' };\n`,
    );
    return root;
}

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('loadTypeScript', () => {
    it('returns null (not a half-built module) when typescript exposes no compiler API', async () => {
        const root = rootWithApiLessTypeScript();
        const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            // Both must degrade rather than hand back `{ version }`, whose first `ts.ScriptTarget`
            // read would throw `Cannot read properties of undefined (reading 'Latest')` mid-build.
            expect(loadTypeScriptSync(root)).toBeNull();
            await expect(loadTypeScript(root)).resolves.toBeNull();
        } finally {
            warn.mockRestore();
        }
    });

    it('returns null when typescript is not installed at all', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `toil-nots-${process.pid}-`));
        dirs.push(root);
        fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}');
        expect(loadTypeScriptSync(root)).toBeNull();
        await expect(loadTypeScript(root)).resolves.toBeNull();
    });

    it('returns the compiler API when a usable typescript is installed', async () => {
        // This repo's own root resolves its devDependency typescript, which has the classic API.
        const root = path.resolve(__dirname, '..');
        expect(loadTypeScriptSync(root)?.createSourceFile).toBeTypeOf('function');
        expect((await loadTypeScript(root))?.ScriptTarget.Latest).toBeTypeOf('number');
    });
});

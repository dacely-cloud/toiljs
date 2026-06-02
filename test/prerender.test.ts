import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { extractStaticMetadata } from '../src/compiler/prerender';

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

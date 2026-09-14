import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
        expect(extractStaticMetadata(file)).toEqual({
            title: 'X',
            keywords: ['a', 'b'],
            openGraph: { type: 'website' },
        });
    });

    it('returns null when there is no static metadata export', () => {
        expect(
            extractStaticMetadata(tmp(`export default function P() { return null; }\n`)),
        ).toBeNull();
        // generateMetadata (a function) is not a static object literal → not extracted.
        expect(
            extractStaticMetadata(tmp(`export const generateMetadata = () => ({ title: 'X' });\n`)),
        ).toBeNull();
    });

    it('skips computed/non-literal properties but keeps the static ones', () => {
        const file = tmp(`const x = foo();\nexport const metadata = { title: 'X', dyn: x };\n`);
        expect(extractStaticMetadata(file)).toEqual({ title: 'X' });
    });
});

describe('TypeScript 7 metadata syntax', () => {
    it('unwraps satisfies, assertions and parentheses without evaluating route code', () => {
        const file = tmp(`
throw new Error('must never execute');
export const metadata = ({ title: 'Typed', score: -2, nested: { ok: true }, dynamic: call() } as const) satisfies Record<string, unknown>;
export default () => <main />;
`);
        expect(extractStaticMetadata(file)).toEqual({
            title: 'Typed',
            score: -2,
            nested: { ok: true },
        });
    });

    it('fails malformed route syntax instead of silently dropping SEO metadata', () => {
        expect(() => extractStaticMetadata(tmp('export const metadata = { title: ;'))).toThrow(
            'Cannot parse route',
        );
    });

    it('treats __proto__ as data and skips dynamic array elements', () => {
        const result = extractStaticMetadata(
            tmp(
                `export const metadata = { '__proto__': { injected: true }, keywords: ['safe', dynamic()] };`,
            ),
        );
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(Object.hasOwn(result!, '__proto__')).toBe(true);
        expect(result?.keywords).toBeUndefined();
        expect(({} as { injected?: boolean }).injected).toBeUndefined();
    });
});

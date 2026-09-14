import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const root = path.resolve(import.meta.dirname, '..');

function lint(source: string, rules: Record<string, unknown>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-oxlint-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: { strict: true, target: 'ESNext', module: 'ESNext', types: [] },
            include: ['*.ts'],
        }),
    );
    fs.writeFileSync(path.join(dir, 'input.ts'), source);
    fs.writeFileSync(
        path.join(dir, '.oxlintrc.json'),
        JSON.stringify({
            categories: { correctness: 'off' },
            plugins: ['typescript'],
            jsPlugins: [
                { name: 'toiljs', specifier: path.join(root, 'presets/no-uint8array-tostring.js') },
            ],
            rules,
        }),
    );
    const result = spawnSync(
        path.join(root, 'node_modules/.bin/oxlint'),
        ['--type-aware', '--threads', '1', '--format', 'json', 'input.ts'],
        { cwd: dir, encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    const output = JSON.parse(result.stdout) as {
        diagnostics: { code: string; message: string; labels: { span: { offset: number } }[] }[];
    };
    return { ...result, diagnostics: output.diagnostics };
}

describe('Oxlint with TypeScript 7', () => {
    it('runs the tsgolint semantic engine', () => {
        const result = lint('async function work(): Promise<number> { return 1; }\nwork();', {
            'typescript/no-floating-promises': 'error',
        });
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0].code).toContain('no-floating-promises');
    });

    it('checks byte types through aliases, intersections, unions, inheritance and constraints', () => {
        const result = lint(
            `
const unicode = '😀';
declare const bytes: Uint8Array;
bytes.toString();
type Bytes = Uint8Array & { brand: 'bytes' };
declare const branded: Bytes;
branded.toString();
class Plain extends Uint8Array {}
new Plain().toString();
declare const union: Bytes | Plain;
union.toString();
function constrained<T extends Uint8Array>(value: T) { value.toString(); }
function nested<T extends Bytes>(value: T) { value.toString(); }
`,
            { 'toiljs/no-uint8array-tostring': 'error' },
        );
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.diagnostics, result.stdout + result.stderr).toHaveLength(6);
        expect(result.diagnostics.every((d) => d.code.includes('no-uint8array-tostring'))).toBe(
            true,
        );
    });

    it('allows intentional overrides, mixed unions, strings and explicit arguments', () => {
        const result = lint(
            `
class Hex extends Uint8Array { toString(): string { return '00'; } }
new Hex().toString();
class Child extends Hex {}
new Child().toString();
interface Encoded extends Uint8Array { toString(): string; }
declare const encoded: Encoded;
encoded.toString();
declare const mixed: Uint8Array | string;
mixed.toString();
'hello'.toString();
declare const bytes: Uint8Array;
bytes.toString('hex');
`,
            { 'toiljs/no-uint8array-tostring': 'error' },
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.diagnostics).toEqual([]);
    });
});

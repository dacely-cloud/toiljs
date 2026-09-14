import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkNativeTypeScriptConfig, runDoctor } from '../src/cli/doctor';

const dirs: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-doctor-migration-'));
    dirs.push(dir);
    fs.symlinkSync(
        path.resolve(import.meta.dirname, '../node_modules'),
        path.join(dir, 'node_modules'),
        'junction',
    );
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(dir, 'input.ts'), 'export {};\n');
    return dir;
}

describe('doctor TypeScript 7 migration', () => {
    it('checks inherited removed compiler options through the native compiler', async () => {
        const dir = project();
        fs.writeFileSync(
            path.join(dir, 'base.json'),
            '{"compilerOptions":{"baseUrl":".","target":"es5"}}',
        );
        fs.writeFileSync(
            path.join(dir, 'tsconfig.json'),
            '{"extends":"./base.json","files":["input.ts"]}',
        );
        const result = await checkNativeTypeScriptConfig(dir);
        expect(result.status).toBe('fail');
        expect(result.detail).toContain('baseUrl');
        expect(result.detail).toContain('target=ES5');
        expect(fs.existsSync(path.join(dir, 'input.js'))).toBe(false);
    });

    it('accepts the shipped TypeScript 7 preset', async () => {
        const dir = project();
        fs.writeFileSync(
            path.join(dir, 'tsconfig.json'),
            JSON.stringify({
                extends: path.resolve(import.meta.dirname, '../presets/tsconfig.json'),
                files: ['input.ts'],
            }),
        );
        expect((await checkNativeTypeScriptConfig(dir)).status).toBe('pass');
    });

    it('migrates every compiler declaration and the editor idempotently', async () => {
        const dir = project();
        fs.writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { typescript: '^6.0.3' },
                devDependencies: { typescript: 'latest' },
                peerDependencies: { typescript: '>=6' },
                optionalDependencies: { typescript: '^8.0.0' },
            }),
        );
        fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{"files":["input.ts"]}');
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        await runDoctor({ cwd: dir, fix: true, json: true });
        const first = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
        const pkg = JSON.parse(first) as Record<string, Record<string, string>>;
        for (const field of [
            'dependencies',
            'devDependencies',
            'peerDependencies',
            'optionalDependencies',
        ])
            expect(pkg[field].typescript).toBe('^7.0.2');
        const editor = JSON.parse(fs.readFileSync(path.join(dir, '.vscode/settings.json'), 'utf8'));
        expect(editor['js/ts.experimental.useTsgo']).toBe(true);
        expect(editor['typescript.tsdk']).toBeUndefined();
        await runDoctor({ cwd: dir, fix: true, json: true });
        expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(first);
    });
});

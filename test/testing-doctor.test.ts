import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/cli/doctor';
import { checkTesting, type TestingFacts } from '../src/cli/testing-checks';
import { ensureTesting } from '../src/cli/test-setup';
import { TEST_DEPENDENCIES, TEST_SCRIPTS } from '../src/cli/testing';

const directories: string[] = [];
afterEach((): void => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function project(): string {
    const root: string = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-testing-doctor-'));
    directories.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    return root;
}
const healthy: TestingFacts = {
    dependencies: TEST_DEPENDENCIES,
    installed: {
        vitest: '5.0.3',
        '@vitest/coverage-v8': '5.0.3',
        '@vitest/browser-webdriverio': '5.0.0',
        webdriverio: '10.0.2',
    },
    scripts: TEST_SCRIPTS,
    configuration: { file: 'vitest.config.ts', native: true },
};

describe('testing doctor diagnostics', (): void => {
    it('passes a complete native setup and detects installed versions rather than declared ranges', (): void => {
        expect(checkTesting(healthy).every((check): boolean => check.status === 'pass')).toBe(true);
        const stale: TestingFacts = {
            ...healthy,
            installed: { ...healthy.installed, vitest: '4.1.0' },
        };
        expect(checkTesting(stale)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'testing:vitest',
                    status: 'fail',
                    detail: expect.stringContaining('4.1.0'),
                }),
                expect.objectContaining({ id: 'testing:coverage-match', status: 'fail' }),
            ]),
        );
    });
    it('warns on legacy apps, but fails on missing packages once testing is configured', (): void => {
        const legacy: TestingFacts = {
            dependencies: {},
            installed: {},
            scripts: {},
            configuration: { file: null, native: true },
        };
        expect(checkTesting(legacy).every((check): boolean => check.status === 'warn')).toBe(true);
        expect(checkTesting({ ...healthy, installed: {} })).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'testing:webdriverio', status: 'fail' }),
            ]),
        );
    });
    it('reports missing scripts and preserves custom configurations', (): void => {
        expect(
            checkTesting({
                ...healthy,
                scripts: { test: 'vitest run' },
                configuration: { file: 'vitest.config.mts', native: false },
            }),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'testing:scripts',
                    status: 'warn',
                    detail: expect.stringContaining('test:coverage'),
                }),
                expect.objectContaining({
                    id: 'testing:config',
                    status: 'pass',
                    detail: expect.stringContaining('custom, preserved'),
                }),
            ]),
        );
    });
    it('handles malformed installed metadata without crashing', (): void => {
        expect(
            checkTesting({ ...healthy, installed: { ...healthy.installed, vitest: 'broken' } }),
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'testing:coverage-match', status: 'fail' }),
            ]),
        );
    });
    it('includes Testing in JSON reports without mutating the project', async (): Promise<void> => {
        const root: string = project();
        const before: string = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
        let output: string = '';
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk): boolean => {
            output += String(chunk);
            return true;
        });
        await runDoctor({ cwd: root, json: true });
        const report: unknown = JSON.parse(output);
        expect(report).toMatchObject({
            groups: expect.arrayContaining([expect.objectContaining({ title: 'Testing' })]),
        });
        expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(before);
        expect(fs.existsSync(path.join(root, 'vitest.config.ts'))).toBe(false);
        expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    });
    it('repairs missing test setup, includes and ignores without installing, then stays idempotent', async (): Promise<void> => {
        const root: string = project();
        fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"include":["client","shared"]}');
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        await runDoctor({ cwd: root, fix: true, json: true });
        const first: string = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
        expect(JSON.parse(first)).toMatchObject({
            devDependencies: TEST_DEPENDENCIES,
            scripts: TEST_SCRIPTS,
        });
        expect(fs.existsSync(path.join(root, 'tests/TestCounter.browser.test.tsx'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'))).toMatchObject(
            { include: ['client', 'shared', 'tests', 'vitest.config.ts'] },
        );
        expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('coverage');
        await runDoctor({ cwd: root, fix: true, json: true });
        expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(first);
        expect((await ensureTesting(root, true)).changed).toEqual([]);
    });
    it('repairs unsupported versions while preserving custom config, scripts, and metadata', async (): Promise<void> => {
        const root: string = project();
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                private: true,
                scripts: { test: 'vitest run --reporter=verbose' },
                devDependencies: { vitest: '^4.0.0', '@vitest/coverage-v8': '^4.0.0' },
            }),
        );
        const source: string = 'export default { test: { name: "custom" } };';
        fs.writeFileSync(path.join(root, 'vitest.config.mts'), source);
        const result = await ensureTesting(root, true);
        expect(result.changed.length).toBeGreaterThan(0);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).toMatchObject({
            private: true,
            devDependencies: TEST_DEPENDENCIES,
            scripts: { test: 'vitest run --reporter=verbose' },
        });
        expect(fs.readFileSync(path.join(root, 'vitest.config.mts'), 'utf8')).toBe(source);
        expect(fs.existsSync(path.join(root, 'vitest.config.ts'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'tests'))).toBe(false);
        expect((await ensureTesting(root, true)).changed).toEqual([]);
    });
    it('preserves explicit package sources and repairs empty scripts', async (): Promise<void> => {
        const root: string = project();
        await fs.promises.writeFile(
            path.join(root, 'package.json'),
            JSON.stringify({
                scripts: { test: '' },
                devDependencies: { vitest: 'file:../custom-vitest' },
            }),
        );
        await ensureTesting(root, true);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).toMatchObject({
            devDependencies: { vitest: 'file:../custom-vitest' },
            scripts: { test: 'toiljs test' },
        });
    });

    it('preserves commented TypeScript configuration and reports the manual change', async (): Promise<void> => {
        const root: string = project();
        const source: string = '{ // custom\n "include": ["client"] }';
        fs.writeFileSync(path.join(root, 'tsconfig.json'), source);
        expect((await ensureTesting(root, true)).skipped).toEqual(
            expect.arrayContaining([expect.stringContaining('tsconfig.json')]),
        );
        expect(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')).toBe(source);
    });
});

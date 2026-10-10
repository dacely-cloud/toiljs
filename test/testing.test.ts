import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureTesting, parseTestArgs } from '../src/cli/test';
import { detectPackageManager } from '../src/cli/update';
import { TEST_DEPENDENCIES, TEST_SCRIPTS, testingFiles } from '../src/cli/testing';
import { defineTestConfig } from '../src/testing/config';

const directories: string[] = [];
afterEach(async (): Promise<void> => {
    for (const directory of directories.splice(0))
        await fs.rm(directory, { recursive: true, force: true });
});
async function project(pkg: string = '{"name":"fixture","private":true}'): Promise<string> {
    const directory: string = await fs.mkdtemp(path.join(os.tmpdir(), 'toil-test-setup-'));
    directories.push(directory);
    await fs.writeFile(path.join(directory, 'package.json'), pkg);
    return directory;
}

describe('native Vitest setup', (): void => {
    it('installs all test tooling and writes examples without a server build', async (): Promise<void> => {
        const root: string = await project();
        expect(await ensureTesting(root)).toMatchObject({ install: true, native: true });
        const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
        expect(pkg.devDependencies).toEqual(TEST_DEPENDENCIES);
        expect(pkg.scripts).toEqual(TEST_SCRIPTS);
        for (const [file, contents] of Object.entries(testingFiles()))
            expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(contents);
        expect(await ensureTesting(root)).toMatchObject({ install: true, native: true });
        expect(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))).toEqual(pkg);
    });

    it('does not reinstall installed dependencies with private package metadata', async (): Promise<void> => {
        const root: string = await project();
        await ensureTesting(root);
        for (const name of Object.keys(TEST_DEPENDENCIES)) {
            const installed: string = path.join(root, 'node_modules', name);
            await fs.mkdir(installed, { recursive: true });
            await fs.writeFile(
                path.join(installed, 'package.json'),
                JSON.stringify({ name, type: 'module', exports: './index.js' }),
            );
            await fs.writeFile(path.join(installed, 'index.js'), 'export const installed = true;');
        }
        expect(await ensureTesting(root)).toMatchObject({ install: false, native: true });
    });

    it('preserves custom Vitest configuration, scripts, dependencies and unrelated metadata', async (): Promise<void> => {
        const root: string = await project(
            JSON.stringify({
                name: 'custom',
                custom: { keep: true },
                scripts: { test: 'vitest run' },
                devDependencies: { vitest: '^5.0.3' },
            }),
        );
        const config: string = "export default { test: { name: 'custom' } };\n";
        await fs.writeFile(path.join(root, 'vitest.config.mts'), config);
        expect((await ensureTesting(root)).native).toBe(false);
        expect(await fs.readFile(path.join(root, 'vitest.config.mts'), 'utf8')).toBe(config);
        await expect(fs.access(path.join(root, 'vitest.config.ts'))).rejects.toThrow();
        await expect(fs.access(path.join(root, 'tests/Greeting.test.ts'))).rejects.toThrow();
        const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
        expect(pkg.custom).toEqual({ keep: true });
        expect(pkg.scripts.test).toBe('vitest run');
        expect(pkg.devDependencies.vitest).toBe('^5.0.3');
    });

    it('keeps existing helper files and recognizes double-quoted native configuration', async (): Promise<void> => {
        const root: string = await project();
        await fs.mkdir(path.join(root, 'client/lib'), { recursive: true });
        await fs.writeFile(
            path.join(root, 'client/lib/Greeting.ts'),
            'export const keep = true;\n',
        );
        await ensureTesting(root);
        expect(await fs.readFile(path.join(root, 'client/lib/Greeting.ts'), 'utf8')).toContain(
            'keep',
        );
        await fs.writeFile(
            path.join(root, 'vitest.config.ts'),
            'import { defineTestConfig } from "toiljs/vitest"; export default defineTestConfig();',
        );
        expect((await ensureTesting(root)).native).toBe(true);
    });

    it('prefers Vitest config over a separate Vite config', async (): Promise<void> => {
        const root: string = await project();
        await fs.writeFile(path.join(root, 'vite.config.ts'), 'export default {};');
        await fs.writeFile(
            path.join(root, 'vitest.config.ts'),
            "import { defineTestConfig } from 'toiljs/vitest'; export default defineTestConfig();",
        );
        expect((await ensureTesting(root)).native).toBe(true);
    });

    it('rejects invalid package maps before writing anything', async (): Promise<void> => {
        const root: string = await project('{"scripts": "bad"}');
        await expect(ensureTesting(root)).rejects.toThrow('string maps');
        expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(
            '{"scripts": "bad"}',
        );
    });
});

it('uses Bun for automatic installation in projects with its current text lockfile', async (): Promise<void> => {
    const root: string = await project();
    await fs.writeFile(path.join(root, 'bun.lock'), '{}');
    await ensureTesting(root);
    expect(detectPackageManager(root).name).toBe('bun');
});

describe('test command flags', (): void => {
    it('forwards file filters, coverage and Vitest options while consuming framework options', (): void => {
        expect(
            parseTestArgs([
                '--root',
                'my app',
                '--browser',
                '--coverage',
                'Counter',
                '--reporter=json',
            ]),
        ).toEqual({
            root: 'my app',
            browser: true,
            all: false,
            watch: false,
            arguments: ['--coverage', 'Counter', '--reporter=json'],
        });
        expect(parseTestArgs(['--all', '-w', '--', '--project=browser'])).toMatchObject({
            all: true,
            watch: true,
            arguments: ['--project=browser'],
        });
    });
    it('rejects contradictory modes and missing roots', (): void => {
        expect(() => parseTestArgs(['--browser', '--all'])).toThrow('either');
        expect(() => parseTestArgs(['--root'])).toThrow('directory');
    });
});

it('ships separated projects, toil globals, React and comprehensive coverage defaults', (): void => {
    const config = defineTestConfig({ root: '/tmp/toil-preset' });
    expect(config.resolve?.alias).toEqual({
        client: '/tmp/toil-preset/client',
        shared: '/tmp/toil-preset/shared',
    });
    expect(config.test?.coverage).toMatchObject({
        provider: 'v8',
        reporter: ['text', 'html', 'json', 'lcov'],
        include: ['client/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}'],
    });
    expect(config.test?.projects).toHaveLength(2);
    const serialized: string = JSON.stringify(config.test?.projects);
    expect(serialized).toContain('unit');
    expect(serialized).toContain('browser');
    expect(serialized).toContain('setup.js');
    expect(serialized).toContain('webdriverio');
    expect(serialized).toContain('\"wdio:enforceWebDriverClassic\":true');
});

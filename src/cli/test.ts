import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { run } from './proc.js';
import { detectPackageManager } from './update.js';
import { TEST_DEPENDENCIES, TEST_SCRIPTS, testingFiles } from './testing.js';

/** Existing package metadata is retained when adding missing test tooling. */
interface TestPackage {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

/** Result used to decide whether installation and the native project filter are needed. */
export interface TestSetup {
    readonly install: boolean;
    readonly native: boolean;
}

/** Options parsed separately so test file filters and Vitest flags pass through unchanged. */
export interface TestCommandOptions {
    readonly root?: string;
    readonly browser: boolean;
    readonly all: boolean;
    readonly watch: boolean;
    readonly arguments: readonly string[];
}

/** Files are created exclusively; existing user configuration, tests, and helpers are preserved. */
async function writeMissing(root: string, file: string, content: string): Promise<void> {
    const target: string = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
        await fs.writeFile(target, content, { flag: 'wx' });
    } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
}

/** Adds dependencies and native starter files to a legacy project without replacing existing files. */
export async function ensureTesting(root: string): Promise<TestSetup> {
    const pkgPath: string = path.join(root, 'package.json');
    const raw: unknown = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('toiljs test: package.json must contain an object.');
    const pkg: TestPackage = raw;
    for (const field of [pkg.scripts, pkg.dependencies, pkg.devDependencies]) {
        if (
            field !== undefined &&
            (field === null ||
                typeof field !== 'object' ||
                Array.isArray(field) ||
                Object.values(field).some((value): boolean => typeof value !== 'string'))
        )
            throw new Error('toiljs test: package scripts and dependencies must be string maps.');
    }
    const files: readonly string[] = await fs.readdir(root);
    const custom: string | undefined =
        files.find((file: string): boolean => /^vitest\.config\.[cm]?[jt]s$/.test(file)) ??
        files.find((file: string): boolean => /^vite\.config\.[cm]?[jt]s$/.test(file));
    const source: string =
        custom === undefined ? '' : await fs.readFile(path.join(root, custom), 'utf8');
    const native: boolean =
        custom === undefined ||
        source.includes("from 'toiljs/vitest'") ||
        source.includes('from "toiljs/vitest"');
    let changed: boolean = false;
    let install: boolean = false;
    const require: NodeJS.Require = createRequire(pkgPath);
    for (const [name, range] of Object.entries(TEST_DEPENDENCIES)) {
        if (pkg.dependencies?.[name] === undefined && pkg.devDependencies?.[name] === undefined) {
            pkg.devDependencies ??= {};
            pkg.devDependencies[name] = range;
            changed = true;
            install = true;
        }
        try {
            require.resolve(`${name}/package.json`);
        } catch {
            install = true;
        }
    }
    pkg.scripts ??= {};
    for (const [name, script] of Object.entries(TEST_SCRIPTS)) {
        if (pkg.scripts[name] !== undefined) continue;
        pkg.scripts[name] = script;
        changed = true;
    }
    if (changed) await fs.writeFile(pkgPath, JSON.stringify(raw, null, 4) + '\n');
    if (custom === undefined) {
        for (const [file, content] of Object.entries(testingFiles()))
            await writeMissing(root, file, content);
    }
    return { install, native };
}

/** Parses framework switches while preserving arguments for Vitest, including file filters. */
export function parseTestArgs(args: readonly string[]): TestCommandOptions {
    let root: string | undefined;
    let browser: boolean = false;
    let all: boolean = false;
    let watch: boolean = false;
    const forwarded: string[] = [];
    for (let index: number = 0; index < args.length; index++) {
        const arg: string = args[index];
        if (arg === '--root') {
            const value: string | undefined = args[++index];
            if (!value) throw new Error('toiljs test: --root requires a directory.');
            root = value;
        } else if (arg === '--browser') browser = true;
        else if (arg === '--all') all = true;
        else if (arg === '--watch' || arg === '-w') watch = true;
        else if (arg !== '--') forwarded.push(arg);
    }
    if (browser && all) throw new Error('toiljs test: use either --browser or --all.');
    return { root, browser, all, watch, arguments: forwarded };
}

/** Installs missing tooling and runs the project's Vitest binary, preserving its exit status. */
export async function runTest(options: TestCommandOptions): Promise<void> {
    const root: string = path.resolve(options.root ?? process.cwd());
    const setup: TestSetup = await ensureTesting(root);
    if (setup.install) {
        const pm: string = detectPackageManager(root).name;
        process.stdout.write(
            `toiljs test: installing Vitest, browser testing, and V8 coverage with ${pm}.\n`,
        );
        await run(pm, ['install'], root, { stdio: 'inherit' });
    }
    const require: NodeJS.Require = createRequire(path.join(root, 'package.json'));
    const cli: string = path.join(
        path.dirname(require.resolve('vitest/package.json')),
        'vitest.mjs',
    );
    const args: string[] = [cli, ...(options.watch ? [] : ['run'])];
    const projectFlag: boolean = options.arguments.some(
        (arg: string): boolean => arg === '--project' || arg.startsWith('--project='),
    );
    if (setup.native && !options.all && !projectFlag)
        args.push('--project', options.browser ? 'browser' : 'unit');
    if (!setup.native && options.browser) args.push('--browser');
    args.push(...options.arguments);
    const code: number = await new Promise<number>((resolve, reject): void => {
        const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (status: number | null): void => resolve(status ?? 1));
    });
    process.exitCode = code;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TEST_DEPENDENCIES, TEST_SCRIPTS, testingFiles } from './testing.js';
import { intersects, satisfies, validRange } from 'semver';
import { isSupportedTestingRange, isTestingSource } from './testing-versions.js';

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
    readonly changed: readonly string[];
    readonly skipped: readonly string[];
}

/** Configuration discovery shared by tests, doctor, and update; custom files are preserved. */
export interface TestConfiguration {
    readonly file: string | null;
    readonly native: boolean;
}

export async function findTestConfiguration(root: string): Promise<TestConfiguration> {
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
    return { file: custom ?? null, native };
}

/** Files are created exclusively; existing user configuration, tests, and helpers are preserved. */
async function writeMissing(root: string, file: string, content: string): Promise<boolean> {
    const target: string = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
        await fs.writeFile(target, content, { flag: 'wx' });
        return true;
    } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
        return false;
    }
}

/** Adds dependencies and native starter files to a legacy project without replacing existing files. */
export async function ensureTesting(
    root: string,
    repairVersions: boolean = false,
): Promise<TestSetup> {
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
    const config: TestConfiguration = await findTestConfiguration(root);
    const { native } = config;
    const changes: string[] = [];
    const skipped: string[] = [];
    let changed: boolean = false;
    let install: boolean = false;
    const require: NodeJS.Require = createRequire(pkgPath);
    for (const [name, range] of Object.entries(TEST_DEPENDENCIES)) {
        for (const dependencies of [pkg.dependencies, pkg.devDependencies]) {
            const declared: string | undefined = dependencies?.[name];
            if (
                repairVersions &&
                dependencies &&
                declared &&
                !isSupportedTestingRange(name, declared) &&
                !isTestingSource(declared)
            ) {
                dependencies[name] = range;
                changes.push(`package.json (${name} ${declared} -> ${range})`);
                changed = true;
                install = true;
            }
        }
        if (pkg.dependencies?.[name] === undefined && pkg.devDependencies?.[name] === undefined) {
            pkg.devDependencies ??= {};
            pkg.devDependencies[name] = range;
            changes.push(`package.json (add ${name})`);
            changed = true;
            install = true;
        }
        try {
            require.resolve(name);
        } catch {
            install = true;
        }
    }
    if (repairVersions) {
        const runnerRange: string | undefined =
            pkg.dependencies?.vitest ?? pkg.devDependencies?.vitest;
        const coverageDependencies: Record<string, string> | undefined =
            pkg.dependencies?.['@vitest/coverage-v8'] !== undefined
                ? pkg.dependencies
                : pkg.devDependencies;
        if (
            runnerRange &&
            isSupportedTestingRange('vitest', runnerRange) &&
            coverageDependencies &&
            validRange(coverageDependencies['@vitest/coverage-v8'] ?? '') !== null
        ) {
            const installedRunner: string | null = await testVersion(require, 'vitest');
            const installedCoverage: string | null = await testVersion(
                require,
                '@vitest/coverage-v8',
            );
            const target: string =
                installedRunner &&
                installedCoverage &&
                installedRunner !== installedCoverage &&
                satisfies(installedRunner, runnerRange)
                    ? installedRunner
                    : intersects(coverageDependencies['@vitest/coverage-v8'], runnerRange)
                      ? coverageDependencies['@vitest/coverage-v8']
                      : runnerRange;
            if (coverageDependencies['@vitest/coverage-v8'] !== target) {
                coverageDependencies['@vitest/coverage-v8'] = target;
                changes.push('package.json (align V8 coverage with Vitest)');
                changed = true;
                install = true;
            }
            if (installedRunner && installedCoverage && installedRunner !== installedCoverage)
                install = true;
        }
    }
    pkg.scripts ??= {};
    for (const [name, script] of Object.entries(TEST_SCRIPTS)) {
        if (pkg.scripts[name]?.trim()) continue;
        pkg.scripts[name] = script;
        changes.push(`package.json (add script ${name})`);
        changed = true;
    }
    if (changed) await fs.writeFile(pkgPath, JSON.stringify(raw, null, 4) + '\n');
    if (config.file === null) {
        for (const [file, content] of Object.entries(testingFiles()))
            if (await writeMissing(root, file, content)) changes.push(file);
    }
    if (native) await includeTestTypes(root, config.file ?? 'vitest.config.ts', changes, skipped);
    await ignoreTestReports(root, changes);
    return { install, native, changed: changes, skipped };
}

/** Extend plain JSON client configs; commented/custom configs remain available for manual repair. */
async function includeTestTypes(
    root: string,
    config: string,
    changes: string[],
    skipped: string[],
): Promise<void> {
    const file: string = path.join(root, 'tsconfig.json');
    let source: string;
    try {
        source = await fs.readFile(file, 'utf8');
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
    }
    try {
        const raw: unknown = JSON.parse(source);
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('Expected an object');
        const parsed: Record<string, unknown> = raw as Record<string, unknown>;
        if (!isStringArray(parsed.include)) {
            skipped.push(
                'tsconfig.json: include tests and the Vitest config in your existing file selection.',
            );
            return;
        }
        const include: string[] = parsed.include;
        const missing: string[] = ['tests', config].filter(
            (entry: string): boolean => !include.includes(entry),
        );
        if (!missing.length) return;
        include.push(...missing);
        await fs.writeFile(file, JSON.stringify(parsed, null, 4) + '\n');
        changes.push('tsconfig.json (include tests and Vitest config)');
    } catch {
        skipped.push(
            'tsconfig.json: include tests and the Vitest config manually; custom JSON was preserved.',
        );
    }
}

async function ignoreTestReports(root: string, changes: string[]): Promise<void> {
    const file: string = path.join(root, '.gitignore');
    let source: string = '';
    try {
        source = await fs.readFile(file, 'utf8');
    } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const lines: readonly string[] = source
        .split(/\r?\n/)
        .map((line: string): string => line.trim().replace(/\/$/, ''));
    const missing: string[] = ['coverage', '.vitest'].filter(
        (entry: string): boolean => !lines.includes(entry) && !lines.includes('/' + entry),
    );
    if (!missing.length) return;
    await fs.writeFile(
        file,
        source + (source && !source.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n',
    );
    changes.push('.gitignore (test reports)');
}

/** Coverage and Vitest export their metadata; missing or malformed external metadata stays unknown. */
async function testVersion(require: NodeJS.Require, name: string): Promise<string | null> {
    try {
        const raw: unknown = JSON.parse(
            await fs.readFile(require.resolve(`${name}/package.json`), 'utf8'),
        );
        return raw !== null &&
            typeof raw === 'object' &&
            'version' in raw &&
            typeof raw.version === 'string'
            ? raw.version
            : null;
    } catch {
        return null;
    }
}

function isStringArray(value: unknown): value is string[] {
    return (
        Array.isArray(value) && value.every((entry: unknown): boolean => typeof entry === 'string')
    );
}

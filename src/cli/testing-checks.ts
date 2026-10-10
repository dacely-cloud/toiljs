import { eq, satisfies, valid } from 'semver';
import type { Check } from './diagnostics.js';
import type { TestConfiguration } from './test-setup.js';
import { TEST_DEPENDENCIES, TEST_SCRIPTS } from './testing.js';
import { isSupportedTestingRange, isTestingSource } from './testing-versions.js';

/** Disk facts; declared dependencies never substitute for their installed versions. */
export interface TestingFacts {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly installed: Readonly<Record<string, string | null>>;
    readonly scripts: Readonly<Record<string, string>>;
    readonly configuration: TestConfiguration;
}

/** Testing is optional for legacy apps until configured; broken configured tooling fails CI. */
export function checkTesting(facts: TestingFacts): Check[] {
    const configured: boolean =
        Object.keys(TEST_DEPENDENCIES).some(
            (name: string): boolean => facts.dependencies[name] !== undefined,
        ) || facts.configuration.file?.startsWith('vitest.config.') === true;
    const repair: string =
        'Run `toiljs doctor --fix`, then your package manager install (or `toiljs test` to install missing tooling).';
    const checks: Check[] = Object.entries(TEST_DEPENDENCIES).map(([name, range]): Check => {
        const installed: string | null = facts.installed[name] ?? null;
        const declared: string | undefined = facts.dependencies[name];
        const ok: boolean =
            installed !== null &&
            declared !== undefined &&
            satisfies(installed, range) &&
            (isSupportedTestingRange(name, declared) || isTestingSource(declared));
        return {
            id: `testing:${name}`,
            label: name,
            status: ok ? 'pass' : configured ? 'fail' : 'warn',
            detail: `${installed ?? 'not installed'}; declared ${declared ?? 'missing'} (requires ${range})`,
            fix: ok ? undefined : repair,
        };
    });
    const runner: string | null = facts.installed.vitest ?? null;
    const coverage: string | null = facts.installed['@vitest/coverage-v8'] ?? null;
    if (runner !== null && coverage !== null) {
        const match: boolean =
            valid(runner) !== null && valid(coverage) !== null && eq(runner, coverage);
        checks.push({
            id: 'testing:coverage-match',
            label: 'Vitest / V8 coverage versions',
            status: match ? 'pass' : 'fail',
            detail: `vitest ${runner}, @vitest/coverage-v8 ${coverage}`,
            fix: match
                ? undefined
                : 'Install matching versions of vitest and @vitest/coverage-v8; run `toiljs update --yes` to refresh both.',
        });
    }
    const configPresent: boolean = facts.configuration.file !== null;
    checks.push({
        id: 'testing:config',
        label: 'Vitest configuration',
        status: configPresent ? 'pass' : 'warn',
        detail: configPresent
            ? `${facts.configuration.file} (${facts.configuration.native ? 'toiljs preset' : 'custom, preserved'})`
            : 'missing',
        fix: configPresent ? undefined : repair,
    });
    const missing: string[] = Object.keys(TEST_SCRIPTS).filter(
        (name: string): boolean => !facts.scripts[name]?.trim(),
    );
    checks.push({
        id: 'testing:scripts',
        label: 'Unit, browser, watch, and coverage scripts',
        status: missing.length ? 'warn' : 'pass',
        detail: missing.length ? `missing ${missing.join(', ')}` : 'configured',
        fix: missing.length ? repair : undefined,
    });
    return checks;
}

import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { run } from './proc.js';
import { detectPackageManager } from './update.js';
import { ensureTesting, type TestSetup } from './test-setup.js';
export { ensureTesting } from './test-setup.js';

/** Options parsed separately so test file filters and Vitest flags pass through unchanged. */
export interface TestCommandOptions {
    readonly root?: string;
    readonly browser: boolean;
    readonly all: boolean;
    readonly watch: boolean;
    readonly arguments: readonly string[];
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

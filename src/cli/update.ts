/**
 * `toiljs update`, a friendly wrapper over `npm-check-updates`: checks the registry for newer
 * dependency versions, shows them grouped by semver bump (major / minor / patch) with colors, lets
 * you pick which to apply (or `-y` for all), bumps package.json, and runs the project's package
 * manager install. ncu is invoked via `npx --yes` so it isn't a permanent dependency of toiljs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { cancel, intro, isCancel, multiselect, note, outro, spinner } from '@clack/prompts';

import { capture, run } from './proc.js';
import { buildRows, parseNcuJson, type Bump, type UpdateRow } from './updates.js';
import { accent, danger, dim, success, warn } from './ui.js';

export interface UpdateOptions {
    readonly root?: string;
    readonly cwd: string;
    /** Apply all available updates without the interactive picker. */
    readonly yes?: boolean;
    /** ncu `--target` (latest | minor | patch | newest | greatest). Default latest. */
    readonly target?: string;
}

interface PackageManager {
    readonly name: string;
    readonly ncuName: string;
}

/** Detects the package manager from the project's lockfile (defaults to npm). */
function detectPackageManager(root: string): PackageManager {
    if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return { name: 'pnpm', ncuName: 'pnpm' };
    if (fs.existsSync(path.join(root, 'yarn.lock'))) return { name: 'yarn', ncuName: 'yarn' };
    if (fs.existsSync(path.join(root, 'bun.lockb'))) return { name: 'bun', ncuName: 'bun' };
    return { name: 'npm', ncuName: 'npm' };
}

/** Reads the merged dependency ranges (deps + devDeps) from a package.json. */
function readDependencies(pkgPath: string): Record<string, string> {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const pkg = parsed as Record<string, unknown>;
    const merge = (v: unknown): Record<string, string> => {
        if (typeof v !== 'object' || v === null) return {};
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
        return out;
    };
    return { ...merge(pkg.dependencies), ...merge(pkg.devDependencies) };
}

function bumpColor(bump: Bump, text: string): string {
    if (bump === 'major') return danger(text);
    if (bump === 'minor') return warn(text);
    if (bump === 'patch') return success(text);
    return dim(text);
}

/** Renders a row as `name  from -> to`, the version part colored by bump. */
function rowLine(row: UpdateRow): string {
    return `${row.name}  ${dim(row.from)} ${dim('->')} ${bumpColor(row.bump, row.to)}`;
}

const TARGETS = new Set(['latest', 'minor', 'patch', 'newest', 'greatest']);

export async function runUpdate(opts: UpdateOptions): Promise<void> {
    const root = path.resolve(opts.root ?? opts.cwd);
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        throw new Error('No package.json here. Run from your project root or pass --root <dir>.');
    }
    const currentDeps = readDependencies(pkgPath);
    const pm = detectPackageManager(root);
    const target = opts.target && TARGETS.has(opts.target) ? opts.target : 'latest';

    const ncuArgs = (extra: string[]): string[] => [
        '--yes',
        'npm-check-updates',
        '--packageManager',
        pm.ncuName,
        '--target',
        target,
        ...extra,
    ];

    intro(accent('toiljs update'));

    const s = spinner();
    s.start('Checking the registry for updates');
    const res = await capture('npx', ncuArgs(['--jsonUpgraded']), root);
    if (res.code !== 0 && res.stdout.indexOf('{') === -1) {
        s.stop('Could not check for updates');
        note(dim(res.stderr.trim() || 'npm-check-updates failed.'), 'Error');
        process.exitCode = 1;
        return;
    }
    const rows = buildRows(parseNcuJson(res.stdout), currentDeps);
    if (rows.length === 0) {
        s.stop('Everything is up to date');
        outro(success('Nothing to update.'));
        return;
    }
    s.stop(`${String(rows.length)} update${rows.length === 1 ? '' : 's'} available`);

    const counts = { major: 0, minor: 0, patch: 0, other: 0 };
    for (const r of rows) counts[r.bump]++;
    note(
        rows.map(rowLine).join('\n'),
        `${danger(`${String(counts.major)} major`)}  ${warn(`${String(counts.minor)} minor`)}  ${success(`${String(counts.patch)} patch`)}`,
    );

    let selected: string[];
    if (opts.yes) {
        selected = rows.map((r) => r.name);
    } else {
        const answer = await multiselect<string>({
            message: 'Select packages to update (space to toggle, enter to confirm)',
            options: rows.map((r) => ({ value: r.name, label: r.name, hint: `${r.from} -> ${r.to}` })),
            initialValues: rows.map((r) => r.name),
            required: false,
        });
        if (isCancel(answer)) {
            cancel('Update cancelled.');
            return;
        }
        selected = answer;
    }

    if (selected.length === 0) {
        outro(dim('No packages selected.'));
        return;
    }

    s.start('Updating package.json');
    const applyAll = selected.length === rows.length;
    await run('npx', ncuArgs(applyAll ? ['-u'] : ['-u', '--filter', selected.join(' ')]), root);
    s.stop('package.json updated');

    s.start(`Installing with ${pm.name}`);
    await run(pm.name, ['install'], root);
    s.stop('Dependencies installed');

    outro(success(`Updated ${String(selected.length)} package${selected.length === 1 ? '' : 's'}.`));
}

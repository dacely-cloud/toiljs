/**
 * `toiljs update`, a friendly wrapper over `npm-check-updates`: checks the registry for newer
 * dependency versions, shows them grouped by semver bump (major / minor / patch) with colors, lets
 * you pick which to apply (or `-y` for all), bumps package.json, and runs the project's package
 * manager install. ncu is invoked via `npx --yes` so it isn't a permanent dependency of toiljs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { cancel, intro, isCancel, multiselect, note, outro, spinner } from '@clack/prompts';

import { MIGRATIONS_README } from './create.js';
import { capture, run } from './proc.js';
import { buildRows, type Bump, parseNcuJson, type UpdateRow, withheldUpgrades } from './updates.js';
import { accent, danger, dim, success, warn } from './ui.js';

export interface UpdateOptions {
    readonly root?: string;
    readonly cwd: string;
    /** Apply all available updates without the interactive picker. */
    readonly yes?: boolean;
    /** ncu `--target` (latest | minor | patch | newest | greatest). Default latest. */
    readonly target?: string;
}

export interface PackageManager {
    readonly name: string;
    readonly ncuName: string;
}

/** Detects the package manager from the project's lockfile (defaults to npm). */
export function detectPackageManager(root: string): PackageManager {
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

/**
 * The server dir(s) of a project: the directories of the toilconfig.json `entries`, conventionally
 * `server/`. Falls back to `<root>/server` when there is no toilconfig (or it has no string entries),
 * matching how `doctor` locates the server tree.
 */
function serverDirs(root: string): string[] {
    const dirs = new Set<string>();
    try {
        const parsed: unknown = JSON.parse(
            fs.readFileSync(path.join(root, 'toilconfig.json'), 'utf8'),
        );
        const entries =
            typeof parsed === 'object' &&
            parsed !== null &&
            Array.isArray((parsed as { entries?: unknown }).entries)
                ? (parsed as { entries: unknown[] }).entries.filter(
                      (e): e is string => typeof e === 'string',
                  )
                : [];
        for (const e of entries) dirs.add(path.dirname(path.resolve(root, e)));
    } catch {
        // no/unreadable toilconfig.json: fall back to the conventional server/ below
    }
    if (dirs.size === 0) dirs.add(path.join(root, 'server'));
    return [...dirs];
}

/**
 * Ensures the ToilDB `migrations/` folder exists under each server dir that exists. `@migrate`
 * functions MUST live in a `*.migration.ts` file under `migrations/` (folder + extension is a
 * compile error otherwise) and the build auto-discovers them, so an up-to-date project keeps the
 * folder ready. Idempotent: only writes the folder + README where the server dir exists and the
 * folder is absent. Returns the project-relative paths created (for the note), empty if nothing.
 */
function ensureMigrationsDirs(root: string): string[] {
    const created: string[] = [];
    for (const dir of serverDirs(root)) {
        if (!fs.existsSync(dir)) continue;
        const migrations = path.join(dir, 'migrations');
        if (fs.existsSync(migrations)) continue;
        fs.mkdirSync(migrations, { recursive: true });
        fs.writeFileSync(path.join(migrations, 'README.md'), MIGRATIONS_README);
        created.push(path.relative(root, migrations) || 'migrations');
    }
    return created;
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

/** Tells the user which upgrades were held back, and why they are not simply missing. */
function noteWithheld(names: readonly string[]): void {
    note(
        names.map((n) => `${dim('-')} ${n}`).join('\n') +
            '\n\n' +
            dim(
                'Held back: this major is not supported by toiljs yet. TypeScript 7 is the native\n' +
                    'port and ships no JavaScript compiler API, so route metadata would stop being\n' +
                    'baked into the built HTML and typescript-eslint would not load.',
            ),
        warn('Not upgraded'),
    );
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

    // Bring the project's structure up to date: ensure the ToilDB migrations folder exists (it is
    // newer than some projects, and the compiler requires @migrate functions to live under it).
    const createdMigrations = ensureMigrationsDirs(root);
    if (createdMigrations.length > 0) {
        note(
            createdMigrations.map((p) => `${dim('+')} ${p}/`).join('\n'),
            'Created ToilDB migrations folder',
        );
    }

    const s = spinner();
    s.start('Checking the registry for updates');
    const res = await capture('npx', ncuArgs(['--jsonUpgraded']), root);
    if (res.code !== 0 && res.stdout.indexOf('{') === -1) {
        s.stop('Could not check for updates');
        note(dim(res.stderr.trim() || 'npm-check-updates failed.'), 'Error');
        process.exitCode = 1;
        return;
    }
    // Hold back upgrades into a major toiljs cannot run on (typescript 7), so neither the picker nor
    // a `-y` run can install one. `--reject` keeps ncu from applying them during `-u` below.
    const upgraded = parseNcuJson(res.stdout);
    const withheld = withheldUpgrades(upgraded);
    for (const name of withheld) delete upgraded[name];

    const rows = buildRows(upgraded, currentDeps);
    if (rows.length === 0) {
        s.stop('Everything is up to date');
        if (withheld.length > 0) noteWithheld(withheld);
        outro(success('Nothing to update.'));
        return;
    }
    s.stop(`${String(rows.length)} update${rows.length === 1 ? '' : 's'} available`);
    if (withheld.length > 0) noteWithheld(withheld);

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
            options: rows.map((r) => ({
                value: r.name,
                label: r.name,
                hint: `${r.from} -> ${r.to}`,
            })),
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
    const reject = withheld.length > 0 ? ['--reject', withheld.join(' ')] : [];
    await run(
        'npx',
        ncuArgs(applyAll ? ['-u', ...reject] : ['-u', '--filter', selected.join(' '), ...reject]),
        root,
    );
    s.stop('package.json updated');

    // Run the install with VISIBLE output (so a failure is diagnosable — npm
    // prints the real error) and handle a non-zero exit gracefully, instead of
    // leaving the spinner spinning forever on a failed install.
    note(dim(`Running ${pm.name} install…`), 'Install');
    try {
        await run(pm.name, ['install'], root, { stdio: 'inherit' });
    } catch {
        outro(
            danger(
                `${pm.name} install failed — package.json was updated to the new versions, but the ` +
                    `install did not finish. Fix the error printed above, then run \`${pm.name} install\`.`,
            ),
        );
        process.exitCode = 1;
        return;
    }

    outro(
        success(`Updated ${String(selected.length)} package${selected.length === 1 ? '' : 's'}.`),
    );
}

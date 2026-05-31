/**
 * `toiljs configure` — toggle a project's client styling features (CSS preprocessor + Tailwind) on
 * an existing app. Detects the current setup, prompts for the desired one, then rewrites the
 * stylesheet(s) + the `client/toil.tsx` imports, edits `package.json`, and syncs node_modules with
 * the project's package manager (so removed features are fully cleaned, not just disabled).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { intro, outro, select, confirm, isCancel, cancel, spinner, note } from '@clack/prompts';
import { loadConfig } from 'toiljs/compiler';
import pc from 'picocolors';

import {
    PKG_VERSION,
    PREPROCESSORS,
    TAILWIND_CSS,
    TAILWIND_ENTRY,
    detectPreprocessor,
    detectTailwind,
    packageDiff,
    preprocessorForExt,
    setStyleImports,
    styleEntry,
    type Preprocessor,
    type StyleFeatures,
} from './features.js';
import { run } from './proc.js';
import { accent, dim } from './ui.js';

export interface ConfigureOptions {
    readonly root?: string;
    readonly cwd: string;
}

const PREPROCESSOR_LABEL: Record<Preprocessor, string> = {
    css: 'Plain CSS',
    sass: 'Sass (SCSS)',
    less: 'Less',
    stylus: 'Stylus',
};

interface PackageJson {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

function bail<T>(value: T | symbol): asserts value is T {
    if (isCancel(value)) {
        cancel('Configuration cancelled.');
        process.exit(0);
    }
}

/** Finds the existing main stylesheet's preprocessor by extension, or null if none is present. */
async function detectStylesheet(clientDir: string): Promise<Preprocessor | null> {
    for (const p of PREPROCESSORS) {
        try {
            await fs.access(path.join(clientDir, styleEntry(p)));
            return p;
        } catch {}
    }
    try {
        await fs.access(path.join(clientDir, 'styles/main.sass'));
        return preprocessorForExt('sass');
    } catch {
        return null;
    }
}

/** Picks the project's package manager from its lockfile (defaults to npm). */
async function detectPackageManager(root: string): Promise<string> {
    const lock: [string, string][] = [
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
        ['bun.lockb', 'bun'],
    ];
    for (const [file, pm] of lock) {
        try {
            await fs.access(path.join(root, file));
            return pm;
        } catch {}
    }
    return 'npm';
}

/** Applies the stylesheet renames, Tailwind entry, and entry imports for the new feature set. */
async function applyStyleFiles(
    clientDir: string,
    from: StyleFeatures,
    to: StyleFeatures,
): Promise<void> {
    if (from.preprocessor !== to.preprocessor) {
        const oldPath = path.join(clientDir, styleEntry(from.preprocessor));
        const newPath = path.join(clientDir, styleEntry(to.preprocessor));
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        try {
            await fs.rename(oldPath, newPath);
        } catch {
            await fs.writeFile(newPath, '', 'utf8');
        }
    }

    const tailwindPath = path.join(clientDir, TAILWIND_ENTRY);
    if (to.tailwind && !from.tailwind) {
        await fs.mkdir(path.dirname(tailwindPath), { recursive: true });
        await fs.writeFile(tailwindPath, TAILWIND_CSS, 'utf8');
    } else if (!to.tailwind && from.tailwind) {
        await fs.rm(tailwindPath, { force: true });
    }

    for (const entry of ['toil.tsx', 'toil.jsx']) {
        const entryPath = path.join(clientDir, entry);
        try {
            const source = await fs.readFile(entryPath, 'utf8');
            await fs.writeFile(entryPath, setStyleImports(source, to), 'utf8');
            return;
        } catch {}
    }
}

/**
 * Applies a styling change to a project on disk (no prompts): rewrites stylesheets + the app
 * entry's imports and edits `package.json`. Exposed for testing and reuse; the package manager is
 * run separately by {@link runConfigure}.
 */
export async function applyConfigure(
    clientDir: string,
    pkgPath: string,
    pkg: PackageJson,
    from: StyleFeatures,
    to: StyleFeatures,
): Promise<void> {
    await applyStyleFiles(clientDir, from, to);
    await applyPackages(pkgPath, pkg, from, to);
}

/** Adds/removes the managed styling packages in `package.json` (sorted devDependencies). */
async function applyPackages(
    pkgPath: string,
    pkg: PackageJson,
    from: StyleFeatures,
    to: StyleFeatures,
): Promise<void> {
    const { add, remove } = packageDiff(from, to);
    const dev: Record<string, string> = { ...pkg.devDependencies };
    const deps: Record<string, string> = { ...pkg.dependencies };
    for (const name of add) dev[name] = PKG_VERSION[name] ?? 'latest';
    for (const name of remove) {
        delete dev[name];
        delete deps[name];
    }
    const sortedDev = Object.fromEntries(Object.entries(dev).sort(([a], [b]) => a.localeCompare(b)));
    const next = {
        ...pkg,
        ...(Object.keys(deps).length ? { dependencies: deps } : {}),
        devDependencies: sortedDev,
    };
    await fs.writeFile(pkgPath, JSON.stringify(next, null, 4) + '\n', 'utf8');
}

/** Human-readable summary of what changed. */
function describe(from: StyleFeatures, to: StyleFeatures): string {
    const lines: string[] = [];
    if (from.preprocessor !== to.preprocessor) {
        lines.push(`preprocessor: ${PREPROCESSOR_LABEL[from.preprocessor]} → ${PREPROCESSOR_LABEL[to.preprocessor]}`);
    }
    if (from.tailwind !== to.tailwind) {
        lines.push(`Tailwind: ${from.tailwind ? 'on' : 'off'} → ${to.tailwind ? 'on' : 'off'}`);
    }
    const { add, remove } = packageDiff(from, to);
    if (add.length) lines.push(`+ ${add.join(', ')}`);
    if (remove.length) lines.push(`- ${remove.join(', ')}`);
    return lines.map((l) => dim('  ') + l).join('\n');
}

/** Runs the interactive configure flow. */
export async function runConfigure(opts: ConfigureOptions): Promise<void> {
    intro(accent(' toiljs configure '));
    const root = path.resolve(opts.root ?? opts.cwd);

    const pkgPath = path.join(root, 'package.json');
    let pkg: PackageJson;
    try {
        pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as PackageJson;
    } catch {
        cancel(`No package.json in ${pc.cyan(root)} — run this inside a toiljs project.`);
        process.exit(1);
    }

    const cfg = await loadConfig({ root });
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const current: StyleFeatures = {
        preprocessor: (await detectStylesheet(cfg.clientAbsDir)) ?? detectPreprocessor(deps),
        tailwind: detectTailwind(deps),
    };

    const ppChoice = await select<Preprocessor>({
        message: 'CSS preprocessor',
        options: PREPROCESSORS.map((value) => ({ value, label: PREPROCESSOR_LABEL[value] })),
        initialValue: current.preprocessor,
    });
    bail(ppChoice);
    const twChoice = await confirm({ message: 'Use Tailwind CSS?', initialValue: current.tailwind });
    bail(twChoice);
    const target: StyleFeatures = { preprocessor: ppChoice, tailwind: twChoice };

    if (target.preprocessor === current.preprocessor && target.tailwind === current.tailwind) {
        outro('No changes — your styling setup is already up to date.');
        return;
    }

    const s = spinner();
    s.start('Updating project files');
    await applyConfigure(cfg.clientAbsDir, pkgPath, pkg, current, target);
    s.stop('Updated stylesheets, entry imports, and package.json');

    const pm = await detectPackageManager(root);
    const i = spinner();
    i.start(`Syncing dependencies with ${pm}`);
    try {
        await run(pm, ['install'], root);
        i.stop('Dependencies synced');
    } catch {
        i.stop(pc.yellow(`Could not run \`${pm} install\` — run it yourself to finish`));
    }

    note(describe(current, target), 'Styling updated');
    outro(`Reconfigured — restart \`${accent('toiljs dev')}\` to pick up the changes.`);
}

/**
 * `toiljs configure`, toggle a project's client styling features (CSS preprocessor + Tailwind) on
 * an existing app. Detects the current setup, prompts for the desired one, then rewrites the
 * stylesheet(s) + the `client/toil.tsx` imports, edits `package.json`, and syncs node_modules with
 * the project's package manager (so removed features are fully cleaned, not just disabled).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { cancel, confirm, intro, isCancel, note, outro, select, spinner } from '@clack/prompts';
import { loadConfig } from 'toiljs/compiler';
import pc from 'picocolors';

import {
    defaultConfigSource,
    detectPreprocessor,
    detectTailwind,
    packageDiff,
    PKG_VERSION,
    type Preprocessor,
    preprocessorForExt,
    PREPROCESSORS,
    setConfigImages,
    setStyleImports,
    styleEntry,
    type StyleFeatures,
    TAILWIND_CSS,
    TAILWIND_ENTRY,
} from './features.js';
import { run } from './proc.js';
import { accent, dim } from './ui.js';

export interface ConfigureOptions {
    readonly root?: string;
    readonly cwd: string;
    /** When set, the corresponding prompt is skipped (non-interactive). */
    readonly preprocessor?: Preprocessor;
    readonly tailwind?: boolean;
    /** Toggle build-time image optimization. When set, the prompt is skipped. */
    readonly images?: boolean;
    /** Run the package manager to sync deps. Default `true`; `false` edits files only. */
    readonly install?: boolean;
}

const CONFIG_FILES = [
    'toil.config.ts',
    'toil.config.mts',
    'toil.config.js',
    'toil.config.mjs',
    'toiljs.config.ts',
    'toiljs.config.mts',
    'toiljs.config.js',
    'toiljs.config.mjs',
];

/** Reads the project's `toil.config.*` (path + source), or null if none exists. */
async function readConfigFile(root: string): Promise<{ path: string; source: string } | null> {
    for (const name of CONFIG_FILES) {
        const p = path.join(root, name);
        try {
            return { path: p, source: await fs.readFile(p, 'utf8') };
        } catch {}
    }
    return null;
}

/**
 * Persists `client.images` to the project's `toil.config`. Edits an existing config in place (or
 * creates `toil.config.ts` if none); returns `false` if the existing file's shape couldn't be
 * edited, so the caller can tell the user to set it by hand.
 */
async function writeImagesFlag(root: string, enabled: boolean): Promise<boolean> {
    const existing = await readConfigFile(root);
    if (!existing) {
        await fs.writeFile(path.join(root, 'toil.config.ts'), defaultConfigSource(enabled), 'utf8');
        return true;
    }
    const next = setConfigImages(existing.source, enabled);
    if (next === null) return false;
    await fs.writeFile(existing.path, next, 'utf8');
    return true;
}

/** Current `client.images` setting (defaults to `true` when the config can't be loaded). */
async function resolveImages(root: string): Promise<boolean> {
    try {
        return (await loadConfig({ root })).images;
    } catch {
        return true;
    }
}

/** Resolves the client source dir, falling back to `<root>/client` if the config can't be loaded. */
async function resolveClientDir(root: string): Promise<string> {
    try {
        const cfg = await loadConfig({ root });
        return cfg.clientAbsDir;
    } catch {
        return path.join(root, 'client');
    }
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

/** Returns the path of the existing `styles/main.*` stylesheet, or null. */
async function findMainStylesheet(clientDir: string): Promise<string | null> {
    for (const ext of ['css', 'scss', 'sass', 'less', 'styl']) {
        const p = path.join(clientDir, 'styles', `main.${ext}`);
        try {
            await fs.access(p);
            return p;
        } catch {}
    }
    return null;
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
        const newPath = path.join(clientDir, styleEntry(to.preprocessor));
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        // Rename whatever main stylesheet actually exists (preserving its content), not an assumed
        // name, so we never blow away the user's styles when the on-disk extension differs.
        const existing = await findMainStylesheet(clientDir);
        if (existing && path.resolve(existing) !== path.resolve(newPath)) {
            await fs.rename(existing, newPath);
        } else if (!existing) {
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
    const sortedDev = Object.fromEntries(
        Object.entries(dev).sort(([a], [b]) => a.localeCompare(b)),
    );
    const next: PackageJson = { ...pkg, devDependencies: sortedDev };
    // Always reflect the pruned dependencies (or drop the key entirely if now empty), so a removed
    // package can't survive via the original `...pkg` spread.
    if (Object.keys(deps).length) next.dependencies = deps;
    else delete next.dependencies;
    await fs.writeFile(pkgPath, JSON.stringify(next, null, 4) + '\n', 'utf8');
}

/** Human-readable summary of what changed. */
function describe(from: StyleFeatures, to: StyleFeatures): string {
    const lines: string[] = [];
    if (from.preprocessor !== to.preprocessor) {
        lines.push(
            `preprocessor: ${PREPROCESSOR_LABEL[from.preprocessor]} → ${PREPROCESSOR_LABEL[to.preprocessor]}`,
        );
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
        cancel(`No package.json in ${pc.cyan(root)}, run this inside a toiljs project.`);
        process.exit(1);
    }

    const clientAbsDir = await resolveClientDir(root);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const current: StyleFeatures = {
        preprocessor: (await detectStylesheet(clientAbsDir)) ?? detectPreprocessor(deps),
        tailwind: detectTailwind(deps),
    };

    const currentImages = await resolveImages(root);

    const nonInteractive =
        opts.preprocessor !== undefined || opts.tailwind !== undefined || opts.images !== undefined;
    let target: StyleFeatures;
    let targetImages: boolean;
    if (nonInteractive) {
        target = {
            preprocessor: opts.preprocessor ?? current.preprocessor,
            tailwind: opts.tailwind ?? current.tailwind,
        };
        targetImages = opts.images ?? currentImages;
    } else {
        const ppChoice = await select<Preprocessor>({
            message: 'CSS preprocessor',
            options: PREPROCESSORS.map((value) => ({ value, label: PREPROCESSOR_LABEL[value] })),
            initialValue: current.preprocessor,
        });
        bail(ppChoice);
        const twChoice = await confirm({
            message: 'Use Tailwind CSS?',
            initialValue: current.tailwind,
        });
        bail(twChoice);
        const imChoice = await confirm({
            message: 'Optimize images at build time?',
            initialValue: currentImages,
        });
        bail(imChoice);
        target = { preprocessor: ppChoice, tailwind: twChoice };
        targetImages = imChoice;
    }

    const styleChanged =
        target.preprocessor !== current.preprocessor || target.tailwind !== current.tailwind;
    const imagesChanged = targetImages !== currentImages;
    if (!styleChanged && !imagesChanged) {
        outro('No changes, your setup is already up to date.');
        return;
    }

    const s = spinner();
    s.start('Updating project files');
    if (styleChanged) await applyConfigure(clientAbsDir, pkgPath, pkg, current, target);
    let imagesWarning = '';
    if (imagesChanged && !(await writeImagesFlag(root, targetImages))) {
        imagesWarning = pc.yellow(
            ' Could not edit toil.config automatically, set `client.images` by hand.',
        );
    }
    s.stop('Updated project files');

    if (styleChanged) {
        const pm = await detectPackageManager(root);
        if (opts.install === false) {
            note(`${pc.cyan(`${pm} install`)} to sync the dependency changes.`, 'Next step');
        } else {
            const i = spinner();
            i.start(`Syncing dependencies with ${pm}`);
            try {
                await run(pm, ['install'], root);
                i.stop('Dependencies synced');
            } catch {
                i.stop(pc.yellow(`Could not run \`${pm} install\`, run it yourself to finish`));
            }
        }
    }

    const summary = [
        styleChanged ? describe(current, target) : '',
        imagesChanged
            ? dim('  ') +
              `image optimization: ${currentImages ? 'on' : 'off'} → ${targetImages ? 'on' : 'off'}`
            : '',
        imagesWarning,
    ]
        .filter(Boolean)
        .join('\n');
    note(summary, 'Updated');
    outro(`Reconfigured, restart \`${accent('toiljs dev')}\` to pick up the changes.`);
}

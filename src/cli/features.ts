/**
 * Pure description of toiljs's optional client styling features — a CSS preprocessor and Tailwind —
 * shared by `create` (scaffold) and `configure` (toggle on existing projects). Dependency-light
 * (no node IO) so it can be unit-tested; the file writes and package-manager calls live in the
 * commands. Preprocessor and Tailwind are independent: Tailwind lives in its own `.css` entry so
 * it never passes through (and breaks on) a preprocessor's `@import` resolution.
 */

/** Supported CSS preprocessor (`css` = none). */
export type Preprocessor = 'css' | 'sass' | 'less' | 'stylus';

/** The two independently-toggleable styling features of a project. */
export interface StyleFeatures {
    readonly preprocessor: Preprocessor;
    readonly tailwind: boolean;
}

export const PREPROCESSORS: readonly Preprocessor[] = ['css', 'sass', 'less', 'stylus'];

/** Main stylesheet extension for each preprocessor. */
export const STYLE_EXT: Record<Preprocessor, string> = {
    css: 'css',
    sass: 'scss',
    less: 'less',
    stylus: 'styl',
};

/** npm package that enables each preprocessor in Vite (plain CSS needs none). */
export const PREPROCESSOR_PKG: Record<Preprocessor, string | null> = {
    css: null,
    sass: 'sass',
    less: 'less',
    stylus: 'stylus',
};

/** Tailwind v4 packages. The framework auto-wires the Vite plugin when `@tailwindcss/vite` resolves. */
export const TAILWIND_PKGS: readonly string[] = ['tailwindcss', '@tailwindcss/vite'];

/** Pinned versions for every package these features may install. */
export const PKG_VERSION: Record<string, string> = {
    sass: '^1.83.0',
    less: '^4.2.1',
    stylus: '^0.64.0',
    tailwindcss: '^4.0.0',
    '@tailwindcss/vite': '^4.0.0',
};

/** Dedicated Tailwind entry (kept `.css` so no preprocessor touches its `@import`). */
export const TAILWIND_ENTRY = 'styles/tailwind.css';
export const TAILWIND_CSS = `@import 'tailwindcss';\n`;

/** Path (relative to `client/`) of the main stylesheet for a preprocessor. */
export function styleEntry(p: Preprocessor): string {
    return `styles/main.${STYLE_EXT[p]}`;
}

/** The preprocessor whose main stylesheet uses `ext` (with or without a leading dot), or null. */
export function preprocessorForExt(ext: string): Preprocessor | null {
    const e = ext.replace(/^\./, '');
    if (e === 'sass') return 'sass';
    return PREPROCESSORS.find((p) => STYLE_EXT[p] === e) ?? null;
}

/** Packages required by a feature set (preprocessor package + Tailwind packages). */
export function requiredPackages(f: StyleFeatures): string[] {
    const pkgs: string[] = [];
    const pp = PREPROCESSOR_PKG[f.preprocessor];
    if (pp) pkgs.push(pp);
    if (f.tailwind) pkgs.push(...TAILWIND_PKGS);
    return pkgs;
}

/** Managed packages to add and remove when moving from `from` to `to`. */
export function packageDiff(
    from: StyleFeatures,
    to: StyleFeatures,
): { add: string[]; remove: string[] } {
    const want = new Set(requiredPackages(to));
    const had = new Set(requiredPackages(from));
    return {
        add: [...want].filter((p) => !had.has(p)),
        remove: [...had].filter((p) => !want.has(p)),
    };
}

/** The side-effect style imports for the app entry, Tailwind first so app CSS can override it. */
export function styleImportLines(f: StyleFeatures): string[] {
    const lines: string[] = [];
    if (f.tailwind) lines.push(`import './${TAILWIND_ENTRY}';`);
    lines.push(`import './${styleEntry(f.preprocessor)}';`);
    return lines;
}

/**
 * Rewrites the `./styles/*` side-effect imports in an app entry (`client/toil.tsx`) to match
 * `features`, preserving the rest of the file. Existing style imports are removed and the new
 * block is placed after the `toiljs/routes` import (or the last import, or the top).
 */
export function setStyleImports(source: string, f: StyleFeatures): string {
    const stripped = source.replace(/^[ \t]*import\s+['"]\.\/styles\/[^'"]+['"];?[ \t]*\r?\n/gm, '');
    const block = styleImportLines(f).join('\n') + '\n';

    const lines = stripped.split('\n');
    const routesIdx = lines.findIndex((l) => /from\s+['"]toiljs\/routes['"]/.test(l));
    let insertAt: number;
    if (routesIdx !== -1) {
        insertAt = routesIdx + 1;
    } else {
        const lastImport = lines.reduce((acc, l, i) => (/^\s*import\s/.test(l) ? i : acc), -1);
        insertAt = lastImport + 1;
    }
    // Surround the inserted block with a blank line on each side, collapsing duplicates after.
    const head = lines.slice(0, insertAt).join('\n');
    const tail = lines.slice(insertAt).join('\n');
    return `${head}\n\n${block}\n${tail}`.replace(/\n{3,}/g, '\n\n');
}

/** Detects the active preprocessor from a project's combined dependency map. */
export function detectPreprocessor(deps: Record<string, string>): Preprocessor {
    if ('sass' in deps) return 'sass';
    if ('less' in deps) return 'less';
    if ('stylus' in deps) return 'stylus';
    return 'css';
}

/** Whether Tailwind is installed in a project's combined dependency map. */
export function detectTailwind(deps: Record<string, string>): boolean {
    return '@tailwindcss/vite' in deps || 'tailwindcss' in deps;
}

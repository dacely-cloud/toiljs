/**
 * Pure input validation for `toiljs create` — kept dependency-light (only node:path) so it can be
 * unit-tested without pulling in the rest of the CLI.
 */
import path from 'node:path';

/** Package managers the scaffolder may invoke. Allowlisted so a hostile `--pm` can't inject a shell command. */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];

/** Validates a project name's characters. Returns `true`, or an error message. */
export function isValidName(name: string): true | string {
    if (!name.trim()) return 'Please enter a project name.';
    if (!/^[a-z0-9._@/-]+$/i.test(name)) return 'Use letters, numbers, dashes, dots or slashes.';
    return true;
}

/**
 * Resolves `name` to an absolute directory under `cwd`, refusing to escape it (a name like
 * `../x` or an absolute path). Returns the resolved dir, or `null` if it would escape `cwd`.
 */
export function resolveProjectDir(cwd: string, name: string): string | null {
    const target = path.resolve(cwd, name);
    const rel = path.relative(cwd, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return target;
}

/** Whether `pm` is a supported package manager (guards shell use of `--pm`). */
export function isPackageManager(pm: string): boolean {
    return PACKAGE_MANAGERS.includes(pm);
}

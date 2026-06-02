/**
 * Pure helpers for `toiljs update`: parse `npm-check-updates --jsonUpgraded` output and classify the
 * semver bump of each upgrade. IO-free so it can be unit-tested; the spawn/UI live in `update.ts`.
 */

/** The kind of version jump an upgrade represents. */
export type Bump = 'major' | 'minor' | 'patch' | 'other';

/** One available upgrade: package, current range, target range, and bump kind. */
export interface UpdateRow {
    readonly name: string;
    readonly from: string;
    readonly to: string;
    readonly bump: Bump;
}

/** Extracts a version's leading `x.y.z` (ignoring `^`, `~`, `>=`, etc.); missing parts become 0. */
function parseVersion(v: string): [number, number, number] {
    const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
    if (!m) return [0, 0, 0];
    return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Classifies the bump from `from` to `to` (both may be ranges like `^1.2.3`). */
export function classifyBump(from: string, to: string): Bump {
    const [fa, fb, fc] = parseVersion(from);
    const [ta, tb, tc] = parseVersion(to);
    if (ta !== fa) return 'major';
    if (tb !== fb) return 'minor';
    if (tc !== fc) return 'patch';
    return 'other';
}

/**
 * Parses the JSON object `npm-check-updates --jsonUpgraded` prints (a `{ name: range }` map). Tolerant
 * of leading/trailing noise (npx banners) by slicing to the outermost braces. Returns `{}` on failure.
 */
export function parseNcuJson(stdout: string): Record<string, string> {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end <= start) return {};
    try {
        const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
        if (typeof parsed !== 'object' || parsed === null) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
        return out;
    } catch {
        return {};
    }
}

const SEVERITY: Record<Bump, number> = { major: 0, minor: 1, patch: 2, other: 3 };

/**
 * Builds the upgrade rows from the ncu map and the project's current dependency ranges, sorted by
 * bump severity (major first) then name.
 */
export function buildRows(
    upgraded: Record<string, string>,
    currentDeps: Record<string, string>,
): UpdateRow[] {
    return Object.entries(upgraded)
        .map(([name, to]) => {
            const from = currentDeps[name] ?? '?';
            return { name, from, to, bump: classifyBump(from, to) };
        })
        .sort((a, b) => SEVERITY[a.bump] - SEVERITY[b.bump] || a.name.localeCompare(b.name));
}

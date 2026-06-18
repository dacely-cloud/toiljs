/**
 * Pure helpers for the automatic toiljs update check that runs on every CLI invocation
 * (and therefore on `npm run dev` / `npm run build`, which call the CLI). IO-free so it
 * can be unit-tested; the registry fetch, cache file, and printing live in `notify.ts`.
 */

/** How long a registry answer is trusted before we ask npm again. */
export const CHECK_TTL_MS = 60 * 60 * 1000;

/** What we persist between runs: the latest known version and when we asked. */
export interface CheckCache {
    readonly latest: string | null;
    readonly checkedAt: number;
}

/** Parses the cache file contents; returns null when malformed (forces a fresh check). */
export function parseCheckCache(raw: string): CheckCache | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const o = parsed as Record<string, unknown>;
        const latest = typeof o.latest === 'string' ? o.latest : null;
        const checkedAt = typeof o.checkedAt === 'number' ? o.checkedAt : NaN;
        if (!Number.isFinite(checkedAt)) return null;
        return { latest, checkedAt };
    } catch {
        return null;
    }
}

/** True when the cached answer is still trustworthy (also stale if the clock went backwards). */
export function isCacheFresh(
    cache: CheckCache,
    now: number,
    ttlMs: number = CHECK_TTL_MS,
): boolean {
    return cache.checkedAt <= now && now - cache.checkedAt < ttlMs;
}

interface Parsed {
    readonly nums: readonly [number, number, number];
    readonly pre: string | null;
}

function parseSemver(v: string): Parsed {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (!m) return { nums: [0, 0, 0], pre: null };
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/**
 * Compares two semver strings: negative when `a < b`, 0 when equal, positive when `a > b`.
 * A prerelease sorts below its release (`0.1.0-beta.1 < 0.1.0`); two prereleases compare
 * lexicographically, which is enough for an update nudge.
 */
export function compareSemver(a: string, b: string): number {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    for (let i = 0; i < 3; i++) {
        if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
    }
    if (pa.pre === pb.pre) return 0;
    if (pa.pre === null) return 1;
    if (pb.pre === null) return -1;
    return pa.pre < pb.pre ? -1 : 1;
}

/** True when `installed` is behind `latest`. */
export function isOutdated(installed: string, latest: string): boolean {
    return compareSemver(installed, latest) < 0;
}

/** The command that updates toiljs for the project's package manager, or globally. */
export function installCommand(pm: string, scope: 'project' | 'global'): string {
    if (scope === 'global') {
        if (pm === 'pnpm') return 'pnpm add -g toiljs@latest';
        if (pm === 'yarn') return 'yarn global add toiljs@latest';
        if (pm === 'bun') return 'bun add -g toiljs@latest';
        return 'npm install -g toiljs@latest';
    }
    if (pm === 'pnpm') return 'pnpm add toiljs@latest';
    if (pm === 'yarn') return 'yarn add toiljs@latest';
    if (pm === 'bun') return 'bun add toiljs@latest';
    return 'npm install toiljs@latest';
}

/** One out-of-date install we want to nag about. */
export interface OutdatedRow {
    /** Where the stale copy lives: the project's node_modules or the global CLI. */
    readonly scope: 'project' | 'global';
    readonly installed: string;
    readonly command: string;
}

/**
 * Decides what (if anything) to warn about. `projectVersion` is the toiljs resolved in the
 * project's node_modules (null when not installed there), `cliVersion` is the copy of the CLI
 * actually running, and `cliIsLocal` tells us whether those are the same install.
 */
export function findOutdated(
    latest: string,
    projectVersion: string | null,
    cliVersion: string,
    cliIsLocal: boolean,
    pm: string,
): OutdatedRow[] {
    const rows: OutdatedRow[] = [];
    if (projectVersion !== null && isOutdated(projectVersion, latest)) {
        rows.push({
            scope: 'project',
            installed: projectVersion,
            command: installCommand(pm, 'project'),
        });
    }
    // The running CLI only gets its own row when it is not the project install we already
    // reported (global installs, or `npx toiljs` outside a project).
    if (!cliIsLocal && isOutdated(cliVersion, latest)) {
        rows.push({
            scope: 'global',
            installed: cliVersion,
            command: installCommand('npm', 'global'),
        });
    }
    return rows;
}

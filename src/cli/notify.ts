/**
 * Automatic update check, run on every CLI invocation (so `npm run dev` / `npm run build`,
 * which call the toiljs CLI, are covered too). Asks the npm registry for the latest toiljs
 * release (answer cached for an hour in the user's cache dir, network capped at 2 seconds),
 * then warns on stderr when the project's installed toiljs or the running CLI is behind.
 * Never throws and never fails the command. Opt out with TOILJS_NO_UPDATE_CHECK=1 (also
 * honors NO_UPDATE_NOTIFIER and CI).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectPackageManager } from './update.js';
import { accent, bold, box, dim, version as cliVersion, warn } from './ui.js';
import { findOutdated, isCacheFresh, type OutdatedRow, parseCheckCache } from './version-check.js';

const REGISTRY_URL = 'https://registry.npmjs.org/toiljs/latest';
const FETCH_TIMEOUT_MS = 2000;

/** Where the registry answer is cached: `$XDG_CACHE_HOME`/`~/.cache` + `toiljs/`. */
function cacheFile(): string {
    const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
    return path.join(base, 'toiljs', 'update-check.json');
}

/** Asks the npm registry for the latest published version; null on any failure. */
async function fetchLatest(): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
        ctrl.abort();
    }, FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(REGISTRY_URL, {
            signal: ctrl.signal,
            headers: { accept: 'application/json' },
        });
        if (!res.ok) return null;
        const data: unknown = await res.json();
        if (typeof data !== 'object' || data === null) return null;
        const v = (data as Record<string, unknown>).version;
        return typeof v === 'string' ? v : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The latest published toiljs version, from the cache when fresh, otherwise from the registry.
 * Failures are cached too (as null) so an offline machine backs off for the TTL instead of
 * paying the fetch timeout on every command.
 */
async function resolveLatest(): Promise<string | null> {
    const file = cacheFile();
    try {
        const cached = parseCheckCache(fs.readFileSync(file, 'utf8'));
        if (cached && isCacheFresh(cached, Date.now())) return cached.latest;
    } catch {}
    const latest = await fetchLatest();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ latest, checkedAt: Date.now() }));
    } catch {}
    return latest;
}

/** Reads the version of the toiljs resolved in the project's node_modules, if any. */
function projectToiljsVersion(root: string): string | null {
    try {
        const raw = fs.readFileSync(
            path.join(root, 'node_modules', 'toiljs', 'package.json'),
            'utf8',
        );
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const v = (parsed as Record<string, unknown>).version;
        return typeof v === 'string' ? v : null;
    } catch {
        return null;
    }
}

function noticeLines(latest: string, rows: OutdatedRow[]): string {
    const header = warn('⚠ ') + bold(`a newer toiljs is available: ${accent(latest)}`);
    const body = rows.map((row) => {
        const where = row.scope === 'project' ? 'this project has' : 'your global CLI is';
        return `${where} ${row.installed}${dim(', update with')} ${accent(row.command)}`;
    });
    return '\n' + box([header, '', ...body], warn) + '\n';
}

/**
 * Checks the project install and the running CLI against the latest release and prints a
 * warning to stderr when either is behind. Safe to await unconditionally: bounded by the
 * cache TTL + fetch timeout, and it swallows every error.
 */
export async function notifyIfOutdated(rootArg: string | undefined): Promise<void> {
    try {
        const env = process.env;
        if (env.TOILJS_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI) return;

        const latest = await resolveLatest();
        if (!latest) return;

        const root = path.resolve(rootArg ?? process.cwd());
        const cliDir = path.dirname(fileURLToPath(import.meta.url));
        const cliIsLocal = cliDir.startsWith(path.join(root, 'node_modules') + path.sep);
        const rows = findOutdated(
            latest,
            projectToiljsVersion(root),
            cliVersion(),
            cliIsLocal,
            detectPackageManager(root).name,
        );
        if (rows.length === 0) return;
        process.stderr.write(noticeLines(latest, rows));
    } catch {}
}

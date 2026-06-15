/**
 * Dev-only source for `Environment.get` / `getSecure`, mirroring the edge's
 * per-tenant env store. Reads two optional dotenv files at the project root:
 *
 *   - `.env`          -> plain vars  (`Environment.get`); `process.env` overlays
 *   - `.env.secrets`  -> secrets     (`Environment.getSecure`); keep gitignored
 *
 * DISJOINT like the edge: `get` sees only vars, `getSecure` only secrets, so a
 * secret never comes back through `get`. Framework-reserved `TOIL_*` keys are
 * host-only and stripped from BOTH buckets (a tenant can't read them).
 *
 * Cached after first read; restart `toiljs dev` to pick up edits. The edge
 * resolves this PER TENANT from `$TOIL_ENV_DIR/<host>.env` + `<host>.env.secrets`
 * (and the edge DB later) through a lazy, bounded cache; dev has a single
 * project, so two files are enough and no eviction is needed.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Keys with this prefix are framework-reserved/host-only (never exposed). */
const RESERVED_PREFIX = 'TOIL_';

interface DevEnv {
    vars: Map<string, string>;
    secrets: Map<string, string>;
}

let cache: DevEnv | null = null;

/** Parse one dotenv value: take inside matching quotes, else cut an inline ` #`. */
function parseValue(rest: string): string {
    const q = rest[0];
    if (q === '"' || q === "'") {
        const end = rest.indexOf(q, 1);
        return end < 0 ? rest.slice(1) : rest.slice(1, end);
    }
    const hash = rest.indexOf(' #');
    return (hash < 0 ? rest : rest.slice(0, hash)).trimEnd();
}

/** Minimal dotenv parser: `KEY=value`, `#` comments, optional `export`, quotes. */
function parseDotenv(text: string, into: Map<string, string>): void {
    for (const raw of text.split('\n')) {
        let line = raw.trim();
        if (line.length === 0 || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice('export '.length);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        if (key.length === 0 || key.startsWith(RESERVED_PREFIX)) continue; // reserved/host-only
        into.set(key, parseValue(line.slice(eq + 1).trim()));
    }
}

function readFileInto(file: string, into: Map<string, string>): void {
    try {
        parseDotenv(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), into);
    } catch {
        /* file absent: skip */
    }
}

function load(): DevEnv {
    if (cache) return cache;
    const vars = new Map<string, string>();
    const secrets = new Map<string, string>();
    // process.env overlays as plain vars (convenient in dev); never as secrets.
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string' && !k.startsWith(RESERVED_PREFIX)) vars.set(k, v);
    }
    readFileInto('.env', vars);
    readFileInto('.env.secrets', secrets);
    cache = { vars, secrets };
    return cache;
}

/** A plain var by exact key, or `null`. Reads ONLY the `.env` (vars) bucket. */
export function devEnvGet(key: string): string | null {
    const e = load();
    return e.vars.has(key) ? (e.vars.get(key) as string) : null;
}

/** A secret by exact key, or `null`. Reads ONLY the `.env.secrets` bucket. */
export function devEnvGetSecure(key: string): string | null {
    const e = load();
    return e.secrets.has(key) ? (e.secrets.get(key) as string) : null;
}

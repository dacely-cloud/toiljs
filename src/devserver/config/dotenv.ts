/**
 * Shared dotenv loader for the dev server (and the future Node self-host): reads
 * a project's `.env` (plain vars) + `.env.secrets` (secrets) and splits out the
 * framework-reserved `TOIL_*` keys (host-only), mirroring the edge's `env_store`.
 *
 * Vite/devserver-free on purpose — both the `Environment.get/getSecure` dev
 * source (`./env.ts`) and the email backend config (`./email/config.ts`) consume
 * this one loader, and the self-host will too.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Keys with this prefix are framework-reserved/host-only (never a tenant var/secret). */
export const RESERVED_PREFIX = 'TOIL_';

export interface LoadedEnv {
    /** Non-reserved `.env` entries + `process.env` overlay → `Environment.get`. */
    readonly vars: Map<string, string>;
    /** Non-reserved `.env.secrets` entries → `Environment.getSecure`. */
    readonly secrets: Map<string, string>;
    /** Reserved `TOIL_*` entries from either file (+ `process.env`) → host-only config. */
    readonly reserved: Map<string, string>;
}

const cache = new Map<string, LoadedEnv>();

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

/**
 * Parse dotenv text into `plain` (non-reserved) and `reserved` (`TOIL_*`):
 * `KEY=value`, `#` comments, optional `export`, optional surrounding quotes.
 */
function parseDotenv(
    text: string,
    plain: Map<string, string>,
    reserved: Map<string, string>,
): void {
    for (const raw of text.split('\n')) {
        let line = raw.trim();
        if (line.length === 0 || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice('export '.length);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        if (key.length === 0) continue;
        const val = parseValue(line.slice(eq + 1).trim());
        (key.startsWith(RESERVED_PREFIX) ? reserved : plain).set(key, val);
    }
}

function readFileInto(
    file: string,
    plain: Map<string, string>,
    reserved: Map<string, string>,
): void {
    try {
        parseDotenv(fs.readFileSync(file, 'utf8'), plain, reserved);
    } catch {
        /* file absent: skip */
    }
}

/**
 * Load `<root>/.env` + `<root>/.env.secrets`, cached by resolved root. `process.env`
 * overlays first (non-reserved → vars, `TOIL_*` → reserved), then the files take
 * precedence. Secrets come only from `.env.secrets`.
 */
export function loadEnvFiles(root: string): LoadedEnv {
    const key = path.resolve(root);
    const hit = cache.get(key);
    if (hit) return hit;

    const vars = new Map<string, string>();
    const secrets = new Map<string, string>();
    const reserved = new Map<string, string>();

    // process.env overlay: non-reserved as plain vars, TOIL_* as reserved config.
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v !== 'string') continue;
        (k.startsWith(RESERVED_PREFIX) ? reserved : vars).set(k, v);
    }
    readFileInto(path.join(key, '.env'), vars, reserved);
    readFileInto(path.join(key, '.env.secrets'), secrets, reserved);

    const out: LoadedEnv = { vars, secrets, reserved };
    cache.set(key, out);
    return out;
}

/** Drop the cache (tests). */
export function clearEnvCache(): void {
    cache.clear();
}

/**
 * Dev-only source for `Environment.get` / `getSecure`, mirroring the edge's
 * per-tenant env store. Reads two optional dotenv files at the project root via
 * the shared loader (`./dotenv.ts`):
 *
 *   - `.env`          -> plain vars  (`Environment.get`); `process.env` overlays
 *   - `.env.secrets`  -> secrets     (`Environment.getSecure`); keep gitignored
 *
 * DISJOINT like the edge: `get` sees only vars, `getSecure` only secrets, so a
 * secret never comes back through `get`. Framework-reserved `TOIL_*` keys are
 * host-only (the email backend config reads them) and never a tenant var/secret.
 *
 * Cached after first read; restart `toiljs dev` to pick up edits. The edge
 * resolves this PER TENANT from `$TOIL_ENV_DIR/<host>.env` + `<host>.env.secrets`
 * (and the edge DB later) through a lazy, bounded cache; dev has a single
 * project, so two files are enough and no eviction is needed.
 */
import { loadEnvFiles } from './dotenv.js';

/** A plain var by exact key, or `null`. Reads ONLY the `.env` (vars) bucket. */
export function devEnvGet(key: string): string | null {
    const v = loadEnvFiles(process.cwd()).vars.get(key);
    return v === undefined ? null : v;
}

/** A secret by exact key, or `null`. Reads ONLY the `.env.secrets` bucket. */
export function devEnvGetSecure(key: string): string | null {
    const v = loadEnvFiles(process.cwd()).secrets.get(key);
    return v === undefined ? null : v;
}

/**
 * Pure diagnostics for `toiljs doctor`. Every check is a pure function that takes already-gathered
 * facts (versions, parsed package data, file contents, scanned routes) and returns a {@link Check}.
 * Kept IO-free so it can be unit-tested in isolation; the file reads, config load, and rendering
 * live in `doctor.ts`. Mirrors the pure/IO split of `validate.ts` and `features.ts`.
 */
import { type Preprocessor } from './features.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

/** One diagnostic result: a labelled outcome with an optional detail and a fix hint. */
export interface Check {
    readonly id: string;
    readonly label: string;
    readonly status: CheckStatus;
    readonly detail?: string;
    readonly fix?: string;
}

/** A titled group of related checks (Environment, Project, ...). */
export interface CheckGroup {
    readonly title: string;
    readonly checks: Check[];
}

/** Tallied counts across all groups. */
export interface DoctorSummary {
    readonly pass: number;
    readonly warn: number;
    readonly fail: number;
}

/** Parses a version string's leading `x.y.z` into a numeric tuple (missing parts default to 0). */
function parseVersion(v: string): [number, number, number] {
    const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
    if (!m) return [0, 0, 0];
    return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/**
 * Whether `version` meets a simple minimum `range` (`>=x.y.z` or a bare `x.y.z`). toiljs's peer
 * ranges are all `>=`, so a full semver resolver is unnecessary; a declared range like `^19.2.6` is
 * compared by its floor.
 */
export function satisfiesMin(version: string, range: string): boolean {
    const [a, b, c] = parseVersion(version);
    const [x, y, z] = parseVersion(range);
    if (a !== x) return a > x;
    if (b !== y) return b > y;
    return c >= z;
}

// --- Environment ----------------------------------------------------------------------------------

export function checkNode(current: string, requiredRange: string): Check {
    const ok = satisfiesMin(current, requiredRange);
    return {
        id: 'node',
        label: 'Node.js',
        status: ok ? 'pass' : 'fail',
        detail: `${current} (requires ${requiredRange})`,
        fix: ok ? undefined : `Upgrade Node to ${requiredRange}.`,
    };
}

export function checkPeer(name: string, installed: string | null, range: string): Check {
    if (installed === null) {
        return {
            id: `peer:${name}`,
            label: name,
            status: 'fail',
            detail: `not installed (requires ${range})`,
            fix: `Install ${name}@"${range}".`,
        };
    }
    const ok = satisfiesMin(installed, range);
    return {
        id: `peer:${name}`,
        label: name,
        status: ok ? 'pass' : 'warn',
        detail: `${installed} (requires ${range})`,
        fix: ok ? undefined : `Update ${name} to ${range}.`,
    };
}

export function checkPackageManager(lockfiles: readonly string[]): Check {
    if (lockfiles.length === 0) {
        return {
            id: 'pm',
            label: 'Package manager',
            status: 'warn',
            detail: 'no lockfile found',
            fix: 'Run an install (npm/pnpm/yarn/bun) to create a lockfile.',
        };
    }
    return { id: 'pm', label: 'Package manager', status: 'pass', detail: lockfiles.join(', ') };
}

/**
 * Flags `npx toiljs ...` inside package.json scripts. Under `npm run`, `node_modules/.bin` is
 * already on PATH, so the `npx` is redundant; worse, the extra `npx` process puts the console in
 * raw / VT-input mode and does not restore it when the run is Ctrl+C'd, leaving the terminal
 * echoing arrow keys as `^[[A` and mis-reading typed input (Windows cmd especially). The scaffold
 * uses a bare `toiljs <cmd>`; this catches projects whose scripts wrap it in `npx`.
 */
export function checkDevScripts(scripts: Record<string, string>): Check {
    const NPX_TOILJS = /(?:^|[\s&|;(])npx\s+toiljs\b/;
    const offenders = Object.keys(scripts).filter((name) => NPX_TOILJS.test(scripts[name] ?? ''));
    if (offenders.length === 0) {
        return { id: 'scripts-npx', label: 'Scripts', status: 'pass' };
    }
    return {
        id: 'scripts-npx',
        label: 'Scripts',
        status: 'warn',
        detail: `${offenders.join(', ')} run via "npx toiljs"`,
        fix: 'Drop npx: use "toiljs <cmd>" (npm run already puts node_modules/.bin on PATH). The npx layer can leave the terminal in raw mode after Ctrl+C, which garbles the shell.',
    };
}

export function checkToiljsInstalled(version: string | null): Check {
    return version
        ? { id: 'toiljs', label: 'toiljs', status: 'pass', detail: version }
        : {
              id: 'toiljs',
              label: 'toiljs',
              status: 'fail',
              detail: 'not a dependency of this project',
              fix: 'Add toiljs to dependencies, or run from the project root with --root.',
          };
}

// --- Project + routing ----------------------------------------------------------------------------

export function checkDir(id: string, label: string, exists: boolean, fix: string): Check {
    return exists
        ? { id, label, status: 'pass' }
        : { id, label, status: 'fail', detail: 'missing', fix };
}

/**
 * Whether the app entry calls `mount(...)` with a `slots` argument. Without it, parallel and
 * intercepting routes are silently dropped (a real bug we shipped a fix for). Heuristic, regex-based.
 */
export function checkMountSlots(entrySource: string | null): Check {
    const label = 'App entry mount()';
    if (entrySource === null) {
        return {
            id: 'mount',
            label,
            status: 'warn',
            detail: 'entry file not found',
            fix: 'Ensure client/toil.tsx calls Toil.mount(...).',
        };
    }
    const call = /\bmount\s*\(([^)]*)\)/.exec(entrySource);
    if (!call) {
        return {
            id: 'mount',
            label,
            status: 'warn',
            detail: 'no mount() call found',
            fix: 'Call Toil.mount(routes, layout, notFound, globalError, slots).',
        };
    }
    const hasSlots = /\bslots\b/.test(call[1]);
    return hasSlots
        ? { id: 'mount', label, status: 'pass', detail: 'passes slots' }
        : {
              id: 'mount',
              label,
              status: 'warn',
              detail: 'mount() is missing the slots argument',
              fix: 'Pass slots last: mount(routes, layout, notFound, globalError, slots). Without it, parallel and intercepting routes are ignored.',
          };
}

export function checkRootElement(indexHtml: string | null): Check {
    const label = 'index.html mount target';
    if (indexHtml === null) {
        return {
            id: 'root-el',
            label,
            status: 'fail',
            detail: 'index.html not found',
            fix: 'Add public/index.html with <div id="root"></div>.',
        };
    }
    const ok = /id\s*=\s*["']root["']/.test(indexHtml);
    return ok
        ? { id: 'root-el', label, status: 'pass' }
        : {
              id: 'root-el',
              label,
              status: 'fail',
              detail: 'no element with id="root"',
              fix: 'Add <div id="root"></div> to public/index.html.',
          };
}

export function checkRoutesPresent(routeCount: number): Check {
    return routeCount > 0
        ? {
              id: 'routes',
              label: 'Routes',
              status: 'pass',
              detail: `${routeCount} route${routeCount === 1 ? '' : 's'}`,
          }
        : {
              id: 'routes',
              label: 'Routes',
              status: 'fail',
              detail: 'no routes found',
              fix: 'Add a page, e.g. client/routes/index.tsx.',
          };
}

export function checkDuplicatePatterns(patterns: readonly string[]): Check {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const p of patterns) {
        if (seen.has(p)) dupes.add(p);
        else seen.add(p);
    }
    return dupes.size === 0
        ? { id: 'route-dupes', label: 'Unique route patterns', status: 'pass' }
        : {
              id: 'route-dupes',
              label: 'Unique route patterns',
              status: 'warn',
              detail: `duplicate: ${[...dupes].join(', ')}`,
              fix: 'Two route files map to the same URL; rename or remove one.',
          };
}

/** A source file scanned for broken asset references. */
export interface SourceFile {
    readonly path: string;
    readonly source: string;
}

/** A relative asset reference that will 404 on a nested route. */
export interface AssetIssue {
    readonly file: string;
    readonly line: number;
    readonly value: string;
}

/** Whether a `src`/`href` string value is a root-relative asset path that breaks on nested routes. */
function isBrokenRelativeAsset(value: string): boolean {
    if (value === '') return false;
    if (value.startsWith('/')) return false; // root-absolute, resolves the same everywhere
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false; // http:, https:, data:, mailto:, ...
    if (value.startsWith('#') || value.startsWith('?')) return false;
    // Only flag asset-looking values (a real file extension), to avoid false positives on app routes.
    return /\.(svgz?|png|jpe?g|gif|webp|avif|ico|css|m?js|woff2?|ttf|otf|eot|mp4|webm|json)$/i.test(
        value,
    );
}

/** Finds string-literal `src=`/`href=` attributes pointing at broken relative asset paths. */
export function findRelativeAssets(files: readonly SourceFile[]): AssetIssue[] {
    const issues: AssetIssue[] = [];
    const attr = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const file of files) {
        const lines = file.source.split('\n');
        for (let i = 0; i < lines.length; i++) {
            attr.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = attr.exec(lines[i])) !== null) {
                const value = m[1] ?? m[2] ?? '';
                if (isBrokenRelativeAsset(value)) {
                    issues.push({ file: file.path, line: i + 1, value });
                }
            }
        }
    }
    return issues;
}

export function checkRelativeAssets(issues: readonly AssetIssue[]): Check {
    if (issues.length === 0) return { id: 'rel-assets', label: 'Asset paths', status: 'pass' };
    const shown = issues
        .slice(0, 5)
        .map((i) => `${i.file}:${String(i.line)} "${i.value}"`)
        .join('; ');
    const more = issues.length > 5 ? `, and ${String(issues.length - 5)} more` : '';
    return {
        id: 'rel-assets',
        label: 'Asset paths',
        status: 'warn',
        detail: `${String(issues.length)} relative reference(s): ${shown}${more}`,
        fix: 'Use a root-absolute path (e.g. "/images/logo.svg") or import the asset; relative paths 404 on nested routes.',
    };
}

// --- Config + assets ------------------------------------------------------------------------------

export function checkConfigLoads(loaded: boolean, error?: string): Check {
    return loaded
        ? { id: 'config', label: 'toil.config loads', status: 'pass' }
        : {
              id: 'config',
              label: 'toil.config loads',
              status: 'fail',
              detail: error ?? 'failed to load',
              fix: 'Fix the error in your toil.config.* so dev/build can read it.',
          };
}

export function checkBasePath(base: string): Check {
    const ok = base === '/' || (base.startsWith('/') && base.endsWith('/'));
    return ok
        ? { id: 'base', label: 'Base path', status: 'pass', detail: base }
        : {
              id: 'base',
              label: 'Base path',
              status: 'warn',
              detail: `"${base}"`,
              fix: 'A non-root base should start and end with "/" (e.g. "/app/").',
          };
}

export function checkSeoUrl(seoConfigured: boolean, hasUrl: boolean): Check {
    if (!seoConfigured) {
        return {
            id: 'seo-url',
            label: 'SEO site url',
            status: 'pass',
            detail: 'SEO not configured',
        };
    }
    return hasUrl
        ? { id: 'seo-url', label: 'SEO site url', status: 'pass' }
        : {
              id: 'seo-url',
              label: 'SEO site url',
              status: 'warn',
              detail: 'seo is set without a url',
              fix: 'Set client.seo.url so sitemap.xml and canonical links are absolute.',
          };
}

/** Facts about the project's styling setup, derived by the orchestrator. */
export interface StylingFacts {
    readonly preprocessorImported: Preprocessor | null;
    readonly preprocessorInstalled: boolean;
    readonly tailwindImported: boolean;
    readonly tailwindInstalled: boolean;
}

export function checkStyling(f: StylingFacts): Check {
    const label = 'Styling';
    if (f.preprocessorImported && f.preprocessorImported !== 'css' && !f.preprocessorInstalled) {
        return {
            id: 'styling',
            label,
            status: 'fail',
            detail: `${f.preprocessorImported} stylesheet imported but ${f.preprocessorImported} is not installed`,
            fix: `Install ${f.preprocessorImported}, or run toiljs configure.`,
        };
    }
    if (f.tailwindImported && !f.tailwindInstalled) {
        return {
            id: 'styling',
            label,
            status: 'fail',
            detail: 'Tailwind entry imported but @tailwindcss/vite is not installed',
            fix: 'Run toiljs configure --tailwind, or install @tailwindcss/vite.',
        };
    }
    return { id: 'styling', label, status: 'pass' };
}

// --- Server / WASM --------------------------------------------------------------------------------

export function checkToilconfig(present: boolean): Check {
    return present
        ? { id: 'toilconfig', label: 'Server target (toilconfig.json)', status: 'pass' }
        : {
              id: 'toilconfig',
              label: 'Server target (toilconfig.json)',
              status: 'warn',
              detail: 'no toilconfig.json (no WebAssembly server)',
              fix: 'Add toilconfig.json + a server/ entry if you want a WASM backend.',
          };
}

export function checkServerEntry(missing: readonly string[]): Check {
    return missing.length === 0
        ? { id: 'server-entry', label: 'Server entries', status: 'pass' }
        : {
              id: 'server-entry',
              label: 'Server entries',
              status: 'fail',
              detail: `missing: ${missing.join(', ')}`,
              fix: 'Create the entry file(s) listed in toilconfig.json "entries", or update them.',
          };
}

export function checkToilscriptInstalled(installed: boolean): Check {
    return installed
        ? { id: 'toilscript', label: 'toilscript compiler', status: 'pass' }
        : {
              id: 'toilscript',
              label: 'toilscript compiler',
              status: 'warn',
              detail: 'toilconfig.json present but toilscript is not installed',
              fix: 'Install toilscript to compile the server to WebAssembly.',
          };
}

export function checkWasmBuilt(exists: boolean): Check {
    return exists
        ? { id: 'wasm', label: 'Server build', status: 'pass' }
        : {
              id: 'wasm',
              label: 'Server build',
              status: 'warn',
              detail: 'no compiled .wasm found',
              fix: 'Run your server build (toilscript) before toiljs start.',
          };
}

// --- Typed RPC (@data / @remote / @service) -------------------------------------------------------

/** Minimum toilscript: @rest/@route + RPC codegen + hardened decoders + @data editor decls (TS2395 fix) + RateLimit-enum @ratelimit typing. */
export const RPC_TOILSCRIPT_MIN = '0.1.27';

/** Whether each piece of the typed-RPC wiring is in place (computed in `doctor.ts`). */
export interface RpcFacts {
    /** `build:server` runs toilscript with `--rpcModule`. */
    readonly buildServerWired: boolean;
    /** tsconfig includes `shared` and has the `shared/*` path alias. */
    readonly tsconfigWired: boolean;
    /** `.gitignore` ignores the generated `shared/server.ts`. */
    readonly gitignoreWired: boolean;
    /** The declared toilscript range is at least {@link RPC_TOILSCRIPT_MIN}. */
    readonly toilscriptOk: boolean;
}

/**
 * One check for the typed-RPC setup (`@data`/`@remote` -> generated `Server`). Warns (does not fail)
 * when an existing project predates the feature, and points at the one-command upgrade.
 */
export function checkRpcWiring(f: RpcFacts): Check {
    const missing: string[] = [];
    if (!f.toilscriptOk) missing.push(`toilscript >=${RPC_TOILSCRIPT_MIN}`);
    if (!f.buildServerWired) missing.push('build:server --rpcModule');
    if (!f.tsconfigWired) missing.push('tsconfig shared/ + alias');
    if (!f.gitignoreWired) missing.push('.gitignore shared/server.ts');
    if (missing.length === 0) {
        return { id: 'rpc-wiring', label: 'typed RPC wiring', status: 'pass' };
    }
    return {
        id: 'rpc-wiring',
        label: 'typed RPC wiring',
        status: 'warn',
        detail: `missing: ${missing.join(', ')}`,
        fix: 'Run `toiljs doctor --fix` to wire @data/@remote RPC (build:server, tsconfig, .gitignore, toilscript).',
    };
}

/**
 * Whether the project's prettier setup pulls in the toilscript plugin (`toiljs/prettier-plugin`,
 * or the `toiljs/prettier` shareable that bundles it). Without it, prettier throws on the server's
 * native function decorators (`@main`, `@remote function ...`).
 */
export function checkPrettierPlugin(present: boolean): Check {
    return present
        ? { id: 'prettier-plugin', label: 'prettier toilscript plugin', status: 'pass' }
        : {
              id: 'prettier-plugin',
              label: 'prettier toilscript plugin',
              status: 'warn',
              detail: 'prettier will fail on @main / @remote-on-function in server code',
              fix: 'Run `toiljs doctor --fix` to add toiljs/prettier-plugin to your prettier config.',
          };
}

export interface RestFacts {
    /** The server declares at least one `@rest` controller. */
    readonly hasControllers: boolean;
    /** Some server file dispatches them: a `Rest.dispatch(` call, or a `RestHandler`. */
    readonly dispatched: boolean;
}

/**
 * Guards the easy-to-miss wiring step for the HTTP layer: a `@rest` controller self-registers,
 * but its routes are only served if a handler calls `Rest.dispatch(req)` (or the project uses
 * `RestHandler`). Without that, the routes silently 404 - a confusing footgun, so we warn.
 */
export function checkRestDispatch(f: RestFacts): Check {
    if (!f.hasControllers || f.dispatched) {
        return { id: 'rest-dispatch', label: 'REST dispatch wiring', status: 'pass' };
    }
    return {
        id: 'rest-dispatch',
        label: 'REST dispatch wiring',
        status: 'warn',
        detail: '@rest controllers found, but nothing calls Rest.dispatch(req) - their routes will not be served',
        fix: 'In your handler add `const hit = Rest.dispatch(req); if (hit != null) return hit;`, or set `Server.handler = () => new RestHandler()`.',
    };
}

/**
 * Whether the server's tsconfig wires the toilscript language-service plugin. The compiler turns
 * each `@collection` field into a STATIC handle (`GuestbookDb.totals`) and injects the `@data`
 * codec / `@user` members, none of which stock TypeScript can see, so without the plugin the editor
 * false-flags them as TS2339. The plugin (editor-only; never runs under `tsc`) clears them.
 */
export function checkServerTsPlugin(present: boolean): Check {
    return present
        ? { id: 'server-ts-plugin', label: 'toilscript editor plugin', status: 'pass' }
        : {
              id: 'server-ts-plugin',
              label: 'toilscript editor plugin',
              status: 'warn',
              detail: 'server tsconfig is missing the toilscript LS plugin, so the editor wrongly flags @database static collections (e.g. GuestbookDb.totals) and @data members as TS2339',
              fix: 'Run `toiljs doctor --fix` to add { "plugins": [{ "name": "toilscript/std/ts-plugin.cjs" }] } to your server tsconfig, then pick the workspace TypeScript version and restart the TS server.',
          };
}

/**
 * Whether the server has a `migrations/` folder. ToilDB `@migrate` functions MUST live in a
 * `*.migration.ts` file under `migrations/` (the toilscript compiler enforces folder + extension as
 * a compile error), and the build auto-discovers them, so a server project should keep the folder
 * ready. Older projects predate the convention, so this WARNS (does not fail) and points at the
 * one-command fix (`toiljs update` creates it).
 */
export function checkMigrationsDir(exists: boolean): Check {
    return exists
        ? { id: 'migrations-dir', label: 'server/migrations/ directory', status: 'pass' }
        : {
              id: 'migrations-dir',
              label: 'server/migrations/ directory',
              status: 'warn',
              detail: 'no server/migrations/ folder; ToilDB @migrate functions must live in a *.migration.ts file under it',
              fix: 'Create server/migrations/ (one <Type>.migration.ts per evolving @data value type), or run `toiljs update` to add it.',
          };
}

// --- Security -------------------------------------------------------------------------------------

/** Whether the project uses the auth primitive, and whether its session secret is configured. */
export interface AuthFacts {
    /** A server source references the auth primitive (`AuthService` / `@user` / `@auth`). */
    readonly usesAuth: boolean;
    /** `AUTH_SESSION_SECRET` is assigned a non-empty value in the local secrets source. */
    readonly sessionSecretSet: boolean;
}

/**
 * Flags the silent insecure default behind the auth primitive. When a project uses sessions but
 * never sets `AUTH_SESSION_SECRET`, the server falls back to a PUBLISHED dev key (see
 * `server/globals/auth.ts`), so anyone can forge a session cookie and skip login. doctor can only
 * see the local secrets source, so it WARNS (the real secret may live on the deploy target) rather
 * than failing CI on a false positive.
 */
export function checkAuthSecrets(f: AuthFacts): Check {
    if (!f.usesAuth || f.sessionSecretSet) {
        return { id: 'auth-secrets', label: 'Session secret', status: 'pass' };
    }
    return {
        id: 'auth-secrets',
        label: 'Session secret',
        status: 'warn',
        detail: 'auth is used but AUTH_SESSION_SECRET is unset: sessions fall back to a PUBLISHED key, so anyone can forge a session cookie and skip login',
        fix: 'Set AUTH_SESSION_SECRET to a long random value in .env.secrets (local) and on your deploy target (also AUTH_OPRF_SEED / AUTH_KEM_SK if you use password login). Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))".',
    };
}

// --- Summary --------------------------------------------------------------------------------------

export function summarize(groups: readonly CheckGroup[]): DoctorSummary {
    let pass = 0;
    let warn = 0;
    let fail = 0;
    for (const group of groups) {
        for (const check of group.checks) {
            if (check.status === 'pass') pass++;
            else if (check.status === 'warn') warn++;
            else fail++;
        }
    }
    return { pass, warn, fail };
}

export function hasFailures(summary: DoctorSummary): boolean {
    return summary.fail > 0;
}

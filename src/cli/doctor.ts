/**
 * `toiljs doctor`, read-only project diagnostics. Gathers facts from disk (package.json, lockfiles,
 * the resolved `toil.config`, the app entry, `index.html`, the scanned routes, client source files,
 * and the server target), runs the pure checks in `diagnostics.ts`, and prints a grouped human
 * report (or `--json` for CI). Never throws on a partial/non-toiljs project: missing inputs become
 * fail/warn checks. Sets a non-zero exit code when any check fails.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type ResolvedToilConfig, scanRoutes } from 'toiljs/compiler';

import {
    type Check,
    checkBasePath,
    checkConfigLoads,
    checkDir,
    checkDuplicatePatterns,
    type CheckGroup,
    checkMountSlots,
    checkNode,
    checkPackageManager,
    checkPeer,
    checkRelativeAssets,
    checkRootElement,
    checkRoutesPresent,
    checkRpcWiring,
    checkSeoUrl,
    checkServerEntry,
    type CheckStatus,
    checkStyling,
    checkToilconfig,
    checkToiljsInstalled,
    checkToilscriptInstalled,
    checkWasmBuilt,
    findRelativeAssets,
    hasFailures,
    type RpcFacts,
    RPC_TOILSCRIPT_MIN,
    satisfiesMin,
    type SourceFile,
    summarize,
} from './diagnostics.js';
import {
    detectTailwind,
    type Preprocessor,
    PREPROCESSOR_PKG,
    preprocessorForExt,
    TAILWIND_ENTRY,
} from './features.js';
import { accent, bold, danger, dim, success, version, warn } from './ui.js';

export interface DoctorOptions {
    readonly root?: string;
    readonly cwd: string;
    /** Emit machine-readable JSON instead of the human report. */
    readonly json?: boolean;
    /** Auto-fix what can be fixed in place (currently the typed-RPC wiring). */
    readonly fix?: boolean;
}

/** Parses a JSON file into a plain object, or null on any error / non-object. */
function readJsonObject(file: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** Coerces a value to a `Record<string, string>` (drops non-string entries). */
function stringRecord(value: unknown): Record<string, string> {
    if (typeof value !== 'object' || value === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
    return out;
}

function readFile(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function writeFile(file: string, content: string): void {
    fs.writeFileSync(file, content);
}

/** Narrows a value to a plain (non-array) object, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

const RPC_MODULE_FLAG = '--rpcModule shared/server.ts';
const RPC_GITIGNORE_LINE = 'shared/server.ts';
const RPC_GITIGNORE_RE = /(^|\n)\s*shared\/server\.ts\s*(\r?\n|$)/;

/** Reads the project and reports which parts of the typed-RPC wiring are present. */
function gatherRpcFacts(root: string): RpcFacts {
    const pkg = readJsonObject(path.join(root, 'package.json'));
    const scripts = pkg ? stringRecord(pkg.scripts) : {};
    const deps = {
        ...(pkg ? stringRecord(pkg.dependencies) : {}),
        ...(pkg ? stringRecord(pkg.devDependencies) : {}),
    };
    const tsconfig = readJsonObject(path.join(root, 'tsconfig.json'));
    const gitignore = readFile(path.join(root, '.gitignore'));

    const buildServerWired = (scripts['build:server'] ?? '').includes('--rpcModule');

    let tsconfigWired = false;
    if (tsconfig) {
        const include = Array.isArray(tsconfig.include) ? tsconfig.include : [];
        const paths = asRecord(asRecord(tsconfig.compilerOptions)?.paths);
        tsconfigWired = include.includes('shared') && paths !== null && 'shared/*' in paths;
    }

    const gitignoreWired = gitignore !== null && RPC_GITIGNORE_RE.test(gitignore);
    const range = deps.toilscript;
    const toilscriptOk = typeof range === 'string' && satisfiesMin(range, RPC_TOILSCRIPT_MIN);

    return { buildServerWired, tsconfigWired, gitignoreWired, toilscriptOk };
}

interface RpcFixResult {
    /** Files written. */
    readonly changed: string[];
    /** Files that need a manual edit (e.g. tsconfig with comments). */
    readonly skipped: string[];
}

/**
 * Applies the typed-RPC wiring in place: appends `--rpcModule` to the toilscript build scripts,
 * adds `shared` (+ the `shared/*` alias) to tsconfig, ignores the generated module, and lifts the
 * toilscript floor. Idempotent; only writes files it actually changes.
 */
function applyRpcFix(root: string): RpcFixResult {
    const changed: string[] = [];
    const skipped: string[] = [];

    const pkgPath = path.join(root, 'package.json');
    const pkgRaw = readFile(pkgPath);
    const pkg = pkgRaw !== null ? readJsonObject(pkgPath) : null;
    if (pkg !== null) {
        let touched = false;
        const scripts = asRecord(pkg.scripts) ?? {};
        for (const key of ['build', 'build:server']) {
            const value = scripts[key];
            if (typeof value === 'string' && value.includes('toilscript') && !value.includes('--rpcModule')) {
                scripts[key] = `${value} ${RPC_MODULE_FLAG}`;
                pkg.scripts = scripts;
                touched = true;
            }
        }
        for (const field of ['devDependencies', 'dependencies']) {
            const bag = asRecord(pkg[field]);
            const current = bag?.toilscript;
            if (bag && typeof current === 'string' && !satisfiesMin(current, RPC_TOILSCRIPT_MIN)) {
                bag.toilscript = `^${RPC_TOILSCRIPT_MIN}`;
                touched = true;
            }
        }
        if (touched) {
            writeFile(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
            changed.push('package.json');
        }
    } else if (pkgRaw !== null) {
        skipped.push('package.json (unparseable)');
    }

    const tsPath = path.join(root, 'tsconfig.json');
    const tsRaw = readFile(tsPath);
    const tsconfig = tsRaw !== null ? readJsonObject(tsPath) : null;
    if (tsconfig !== null) {
        let touched = false;
        const include = Array.isArray(tsconfig.include)
            ? [...(tsconfig.include as unknown[])]
            : ['client', 'toil-env.d.ts', 'toil-routes.d.ts'];
        if (!include.includes('shared')) {
            const at = include.indexOf('client');
            include.splice(at >= 0 ? at + 1 : include.length, 0, 'shared');
            tsconfig.include = include;
            touched = true;
        }
        const co = asRecord(tsconfig.compilerOptions) ?? {};
        const paths = asRecord(co.paths) ?? {};
        if (!('shared/*' in paths)) {
            paths['shared/*'] = ['./shared/*'];
            co.paths = paths;
            tsconfig.compilerOptions = co;
            touched = true;
        }
        if (touched) {
            writeFile(tsPath, JSON.stringify(tsconfig, null, 4) + '\n');
            changed.push('tsconfig.json');
        }
    } else if (tsRaw !== null) {
        skipped.push('tsconfig.json (JSON with comments, add "shared" + paths by hand)');
    }

    const giPath = path.join(root, '.gitignore');
    const giRaw = readFile(giPath);
    if (giRaw === null) {
        writeFile(giPath, `${RPC_GITIGNORE_LINE}\n`);
        changed.push('.gitignore');
    } else if (!RPC_GITIGNORE_RE.test(giRaw)) {
        const sep = giRaw.length === 0 || giRaw.endsWith('\n') ? '' : '\n';
        writeFile(giPath, `${giRaw}${sep}${RPC_GITIGNORE_LINE}\n`);
        changed.push('.gitignore');
    }

    return { changed, skipped };
}

/** Reads the framework's own package.json (engines + peerDependencies) for the requirements. */
function frameworkMeta(): { node: string; peers: Record<string, string> } {
    const pkgPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'package.json',
    );
    const pkg = readJsonObject(pkgPath);
    const engines = pkg ? stringRecord(pkg.engines) : {};
    const peers = pkg ? stringRecord(pkg.peerDependencies) : {};
    return { node: engines.node ?? '>=24.0.0', peers };
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];

/** Reads the app entry source (the file that mounts the app), or null if none is found. */
function readEntry(clientAbsDir: string): string | null {
    for (const name of ['toil.tsx', 'toil.jsx', 'main.tsx', 'main.jsx']) {
        const source = readFile(path.join(clientAbsDir, name));
        if (source !== null && /toiljs\/routes|\bmount\s*\(/.test(source)) return source;
    }
    return null;
}

/** Collects client `.tsx`/`.jsx` sources (capped) for the relative-asset scan. */
function collectSources(root: string, dir: string, cap: number): SourceFile[] {
    const out: SourceFile[] = [];
    const visit = (current: string): void => {
        if (out.length >= cap) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (out.length >= cap) break;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules') visit(full);
            } else if (/\.(tsx|jsx)$/.test(entry.name)) {
                const source = readFile(full);
                if (source !== null) out.push({ path: path.relative(root, full), source });
            }
        }
    };
    visit(dir);
    return out;
}

/** Picks a check glyph in the brand palette. */
function glyph(status: CheckStatus): string {
    if (status === 'pass') return success('✓');
    if (status === 'warn') return warn('⚠');
    return danger('✗');
}

function renderHuman(groups: readonly CheckGroup[]): void {
    const summary = summarize(groups);
    const out: string[] = [];
    for (const group of groups) {
        out.push('  ' + bold(group.title));
        for (const check of group.checks) {
            let line = `    ${glyph(check.status)} ${check.label}`;
            if (check.detail) line += dim(`  ${check.detail}`);
            out.push(line);
            if (check.fix && check.status !== 'pass')
                out.push('       ' + dim(`fix: ${check.fix}`));
        }
        out.push('');
    }
    const parts = [success(`${String(summary.pass)} passed`)];
    if (summary.warn > 0) {
        parts.push(warn(`${String(summary.warn)} warning${summary.warn === 1 ? '' : 's'}`));
    }
    if (summary.fail > 0) parts.push(danger(`${String(summary.fail)} failed`));
    out.push('  ' + parts.join(dim(', ')));
    out.push('');
    process.stdout.write(out.join('\n') + '\n');
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
    const root = path.resolve(opts.root ?? opts.cwd);
    const meta = frameworkMeta();

    const projectPkg = readJsonObject(path.join(root, 'package.json'));
    const deps: Record<string, string> = {
        ...(projectPkg ? stringRecord(projectPkg.dependencies) : {}),
        ...(projectPkg ? stringRecord(projectPkg.devDependencies) : {}),
    };

    // Config (the only async fact). On failure, downstream paths fall back to conventional defaults.
    let cfg: ResolvedToilConfig | null = null;
    let configError: string | undefined;
    try {
        cfg = await loadConfig({ root });
    } catch (err) {
        configError = err instanceof Error ? err.message : String(err);
    }

    const clientAbsDir = cfg ? cfg.clientAbsDir : path.join(root, 'client');
    const routesAbsDir = cfg ? cfg.routesAbsDir : path.join(clientAbsDir, 'routes');
    const publicDir = cfg ? cfg.publicDir : path.join(clientAbsDir, 'public');

    const entrySource = readEntry(clientAbsDir);
    const indexHtml = readFile(path.join(publicDir, 'index.html'));
    const routes = scanRoutes(routesAbsDir);
    const mainPatterns = routes.filter((r) => r.slot === undefined).map((r) => r.pattern);
    const assetIssues = findRelativeAssets(collectSources(root, clientAbsDir, 200));

    // Styling facts from the entry's style imports.
    let preprocessorImported: Preprocessor | null = null;
    let tailwindImported = false;
    if (entrySource) {
        const styleImport = /import\s+['"]\.\/styles\/main\.([a-z]+)['"]/.exec(entrySource);
        if (styleImport) preprocessorImported = preprocessorForExt(styleImport[1]);
        tailwindImported = entrySource.includes(TAILWIND_ENTRY);
    }
    const ppPkg = preprocessorImported ? PREPROCESSOR_PKG[preprocessorImported] : null;
    const preprocessorInstalled = ppPkg === null || ppPkg in deps;

    // Server / WASM facts.
    const toilconfig = readJsonObject(path.join(root, 'toilconfig.json'));
    const serverPresent = toilconfig !== null;
    let missingEntries: string[] = [];
    let toilscriptInstalled = false;
    let wasmExists = false;
    if (toilconfig) {
        const entries = Array.isArray(toilconfig.entries)
            ? toilconfig.entries.filter((e): e is string => typeof e === 'string')
            : [];
        missingEntries = entries.filter((e) => !fs.existsSync(path.join(root, e)));
        try {
            createRequire(path.join(root, 'package.json')).resolve('toilscript');
            toilscriptInstalled = true;
        } catch {
            toilscriptInstalled = false;
        }
        const targets =
            typeof toilconfig.targets === 'object' && toilconfig.targets !== null
                ? (toilconfig.targets as Record<string, unknown>)
                : {};
        const outFiles: string[] = [];
        for (const target of Object.values(targets)) {
            if (typeof target === 'object' && target !== null) {
                const outFile = (target as Record<string, unknown>).outFile;
                if (typeof outFile === 'string') outFiles.push(outFile);
            }
        }
        wasmExists = outFiles.some((f) => fs.existsSync(path.join(root, f)));
        if (!wasmExists && outFiles.length === 0) {
            try {
                wasmExists = fs
                    .readdirSync(path.join(root, 'build', 'server'))
                    .some((f) => f.endsWith('.wasm'));
            } catch {
                wasmExists = false;
            }
        }
    }

    const peerName = (n: string): Check => checkPeer(n, deps[n] ?? null, meta.peers[n] ?? '*');
    const peerChecks = Object.keys(meta.peers).map(peerName);

    // Typed-RPC wiring: optionally fix it in place, then read the (possibly updated) state.
    const rpcFix = serverPresent && opts.fix ? applyRpcFix(root) : null;
    const rpcFacts = gatherRpcFacts(root);

    const groups: CheckGroup[] = [
        {
            title: 'Environment',
            checks: [
                checkNode(process.versions.node, meta.node),
                checkToiljsInstalled('toiljs' in deps ? version() : null),
                ...peerChecks,
                checkPackageManager(LOCKFILES.filter((f) => fs.existsSync(path.join(root, f)))),
            ],
        },
        {
            title: 'Project + routing',
            checks: [
                checkDir(
                    'client-dir',
                    'client/ directory',
                    fs.existsSync(clientAbsDir),
                    'Create a client/ directory for your app.',
                ),
                checkDir(
                    'routes-dir',
                    'routes/ directory',
                    fs.existsSync(routesAbsDir),
                    'Create client/routes/ and add an index.tsx.',
                ),
                checkRootElement(indexHtml),
                checkMountSlots(entrySource),
                checkRoutesPresent(routes.length),
                checkDuplicatePatterns(mainPatterns),
                checkRelativeAssets(assetIssues),
            ],
        },
        {
            title: 'Config + assets',
            checks: [
                checkConfigLoads(cfg !== null, configError),
                checkBasePath(cfg ? cfg.base : '/'),
                checkSeoUrl(cfg?.seo != null, cfg?.seo?.url != null),
                checkStyling({
                    preprocessorImported,
                    preprocessorInstalled,
                    tailwindImported,
                    tailwindInstalled: detectTailwind(deps),
                }),
            ],
        },
        {
            title: 'Server / WASM',
            checks: serverPresent
                ? [
                      checkToilconfig(true),
                      checkServerEntry(missingEntries),
                      checkToilscriptInstalled(toilscriptInstalled),
                      checkWasmBuilt(wasmExists),
                      checkRpcWiring(rpcFacts),
                  ]
                : [checkToilconfig(false)],
        },
    ];

    const summary = summarize(groups);
    if (opts.json) {
        process.stdout.write(JSON.stringify({ groups, summary, fixed: rpcFix }, null, 2) + '\n');
    } else {
        process.stdout.write('\n' + accent('  Doctor') + dim(`  ${root}`) + '\n\n');
        renderHuman(groups);
        if (rpcFix) renderRpcFix(rpcFix);
        else if (opts.fix && !serverPresent) {
            process.stdout.write('  ' + dim('--fix: no server (toilconfig.json) found, nothing to wire.') + '\n\n');
        }
    }
    if (hasFailures(summary)) process.exitCode = 1;
}

/** Prints the result of `--fix`, and whether a reinstall is needed (toilscript bump). */
function renderRpcFix(result: RpcFixResult): void {
    const out: string[] = [];
    if (result.changed.length > 0) {
        out.push('  ' + success('fixed RPC wiring') + dim(`  ${result.changed.join(', ')}`));
        if (result.changed.includes('package.json')) {
            out.push('  ' + dim('run your installer (npm/pnpm/yarn) if the toilscript version changed.'));
        }
    } else {
        out.push('  ' + dim('RPC wiring already in place, nothing to fix.'));
    }
    for (const item of result.skipped) out.push('  ' + warn('skipped') + dim(`  ${item}`));
    process.stdout.write(out.join('\n') + '\n\n');
}

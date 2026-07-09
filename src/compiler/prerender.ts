import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type * as TS from 'typescript';
import type { Plugin } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { patternToBracketFile, scanRoutes, staticSectionPattern } from './routes.js';
import { injectSeoHtml, routeSeo } from './seo.js';

type Ts = typeof TS;

/**
 * True when `mod` exposes the classic TypeScript compiler API the static extractor drives.
 *
 * Resolving `typescript` is not enough to know it can parse: TypeScript 7 (the native port) moved
 * the compiler API off the package's main entry, which now exports only `version`. That module is a
 * perfectly good object, so a truthy check passes and the first `ts.ScriptTarget.Latest` then dies
 * with `Cannot read properties of undefined (reading 'Latest')`. Probe the members we actually use.
 */
function isCompilerApi(mod: unknown): mod is Ts {
    const ts = mod as Partial<Ts> | null | undefined;
    return (
        typeof ts?.createSourceFile === 'function' &&
        typeof ts.isVariableStatement === 'function' &&
        typeof ts.ScriptTarget === 'object' &&
        typeof ts.ScriptKind === 'object' &&
        typeof ts.SyntaxKind === 'object'
    );
}

/** Warn once per process: an unusable TypeScript silently costs baked metadata, so say so. */
let warnedUnusable = false;
function warnUnusableTypeScript(mod: unknown): void {
    if (warnedUnusable) return;
    warnedUnusable = true;
    const version = (mod as { version?: string } | null)?.version;
    process.stderr.write(
        `  toil: typescript${version ? `@${version}` : ''} does not expose the compiler API ` +
            `(TypeScript 7 moved it to 'typescript/unstable/*').\n` +
            `  toil: route metadata will NOT be baked into the built HTML. Install typescript ^6 to restore it.\n`,
    );
}

/**
 * Resolves the project's TypeScript, used to read each route's static `metadata`. Returns `null`
 * when it isn't installed (callers then index pages by path only) *or* when the resolved version
 * doesn't expose the compiler API, which is warned about rather than crashing the build.
 */
export async function loadTypeScript(root: string): Promise<Ts | null> {
    let mod: unknown;
    try {
        const resolved = createRequire(path.join(root, 'package.json')).resolve('typescript');
        const ns = (await import(pathToFileURL(resolved).href)) as { default?: Ts } & Ts;
        mod = ns.default ?? ns;
    } catch {
        return null;
    }
    if (isCompilerApi(mod)) return mod;
    warnUnusableTypeScript(mod);
    return null;
}

/** The sync twin of {@link loadTypeScript}, for callers that can't await (e.g. `buildPageIndex`). */
export function loadTypeScriptSync(root: string): Ts | null {
    let mod: unknown;
    try {
        mod = createRequire(path.join(root, 'package.json'))('typescript');
    } catch {
        return null;
    }
    const ts = (mod as { default?: Ts })?.default ?? mod;
    if (isCompilerApi(ts)) return ts;
    warnUnusableTypeScript(ts);
    return null;
}

/** Marks an AST node that isn't a static literal (so its value can't be baked at build). */
const UNRESOLVED = Symbol('unresolved');

/** Statically evaluates a literal expression node to a JS value, or `UNRESOLVED` if it isn't one. */
function evalNode(ts: Ts, node: TS.Expression): unknown {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) {
        const out: unknown[] = [];
        for (const el of node.elements) {
            const value = evalNode(ts, el);
            if (value === UNRESOLVED) return UNRESOLVED;
            out.push(value);
        }
        return out;
    }
    if (ts.isObjectLiteralExpression(node)) return evalObject(ts, node);
    return UNRESOLVED;
}

/** Evaluates an object literal to a plain object, skipping any property that isn't a static literal. */
function evalObject(ts: Ts, node: TS.ObjectLiteralExpression): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name)
              ? prop.name.text
              : null;
        if (key === null) continue;
        const value = evalNode(ts, prop.initializer);
        if (value !== UNRESOLVED) obj[key] = value;
    }
    return obj;
}

/**
 * Extracts the named `export const <name> = { … }` object-literal exports from a route file in a
 * single parse, returning the statically-evaluable subset of each (dynamic and computed values are
 * skipped). Names that are absent or not object literals are omitted from the result.
 */
export function extractStaticExports(
    ts: Ts,
    filePath: string,
    names: readonly string[],
): Record<string, Record<string, unknown>> {
    let source: string;
    try {
        source = fs.readFileSync(filePath, 'utf8');
    } catch {
        return {};
    }
    const wanted = new Set(names);
    const out: Record<string, Record<string, unknown>> = {};
    const sf = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
    for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        for (const decl of stmt.declarationList.declarations) {
            if (
                ts.isIdentifier(decl.name) &&
                wanted.has(decl.name.text) &&
                !(decl.name.text in out) &&
                decl.initializer &&
                ts.isObjectLiteralExpression(decl.initializer)
            ) {
                out[decl.name.text] = evalObject(ts, decl.initializer);
            }
        }
    }
    return out;
}

/**
 * Extracts a route's `export const metadata = { … }` if it's a static object literal, returning the
 * statically-evaluable subset (dynamic `generateMetadata` and computed values are skipped). `null`
 * when the file has no static metadata.
 */
export function extractStaticMetadata(ts: Ts, filePath: string): Record<string, unknown> | null {
    return extractStaticExports(ts, filePath, ['metadata']).metadata ?? null;
}

/**
 * True when the route file has a literal `export const <name> = true`. Used to detect the edge-SSR
 * opt-in (`export const ssr = true`) without spinning up a Vite SSR server, so the static prerender
 * can leave SSR routes to the SSR path.
 */
export function exportsTrue(ts: Ts, filePath: string, name: string): boolean {
    let source: string;
    try {
        source = fs.readFileSync(filePath, 'utf8');
    } catch {
        return false;
    }
    const sf = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
    );
    for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        for (const decl of stmt.declarationList.declarations) {
            if (
                ts.isIdentifier(decl.name) &&
                decl.name.text === name &&
                decl.initializer?.kind === ts.SyntaxKind.TrueKeyword
            ) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Build-only plugin that statically pre-renders per-route HTML for SEO. After the bundle is written,
 * it takes the built shell (`index.html`), and for each route bakes that route's `metadata` (merged
 * over the site-wide `seo` defaults) into a browsable HTML file so a JS-less crawler gets correct
 * per-page tags:
 *   - a STATIC route (`/about`) -> `<route>/index.html`;
 *   - a DYNAMIC route (`/blog/:id`) -> a literal bracket template `blog/[id].html` that the static
 *     server serves for any concrete `/blog/<x>` and the client router hydrates. Its canonical points
 *     at the route's static section (`/blog`); the client sets the exact per-value URL on hydration.
 * A dynamic template is a file, never a `<seg>/index.html` folder, so it never shadows a sibling.
 */
export function prerenderPlugin(cfg: ResolvedToilConfig): Plugin {
    return {
        name: 'toil:prerender-seo',
        apply: 'build',
        async closeBundle() {
            if (!cfg.seo) return;
            const outDir = path.resolve(cfg.root, cfg.outDir);
            const shellPath = path.join(outDir, 'index.html');
            if (!fs.existsSync(shellPath)) return;
            const shell = fs.readFileSync(shellPath, 'utf8');
            // Stash the clean built shell (asset tags, no per-route SEO yet) so the post-build SSG
            // pass bakes dynamic routes from it rather than from this file once it's been overwritten
            // with the `/` route's head (which would duplicate canonical/og tags).
            fs.writeFileSync(path.join(cfg.toilDir, 'shell.html'), shell);
            const ts = await loadTypeScript(cfg.root);

            const routes = scanRoutes(cfg.routesAbsDir).filter(
                (r) => r.slot === undefined && !r.intercept,
            );
            for (const route of routes) {
                const isDynamic = /[:*]/.test(route.pattern);
                // A dynamic route that opts into edge SSR (`export const ssr = true`) is rendered by
                // the SSR template path. Baking a static bracket template would let the edge's
                // static-first serving shadow it, so leave SSR routes to SSR. (When `ts` is null the
                // check is skipped and we bake anyway: fail-OPEN deliberately favors the common
                // non-SSR dynamic route, which would 404 without a template; typescript is always
                // present in a real toiljs project, so this branch is effectively unreachable.)
                if (isDynamic && ts && exportsTrue(ts, route.file, 'ssr')) continue;
                const metadata = ts ? extractStaticMetadata(ts, route.file) : null;
                // A dynamic route's concrete URL is unknown at build, so its canonical/OG URL points
                // at the static section (`/blog/:id` -> `/blog`); the client refines it on hydration.
                const seoPattern = isDynamic ? staticSectionPattern(route.pattern) : route.pattern;
                const html = injectSeoHtml(shell, routeSeo(cfg.seo, metadata, seoPattern));
                // Dynamic -> a literal bracket template (`blog/[id].html`); static -> `<route>/index.html`
                // (the `/` route is the shell itself). The bracket file is never a folder+index.html.
                const target = isDynamic
                    ? path.join(outDir, patternToBracketFile(route.pattern))
                    : route.pattern === '/'
                      ? shellPath
                      : path.join(outDir, route.pattern.replace(/^\//, ''), 'index.html');
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, html);
            }
        },
    };
}

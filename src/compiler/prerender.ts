import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type * as TS from 'typescript';
import type { Plugin } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { scanRoutes } from './routes.js';
import { injectSeoHtml, routeSeo } from './seo.js';

type Ts = typeof TS;

/** Loads the project's TypeScript (used to read each route's static `metadata`), or `null` if absent. */
async function loadTypeScript(root: string): Promise<Ts | null> {
    try {
        const resolved = createRequire(path.join(root, 'package.json')).resolve('typescript');
        const mod = (await import(pathToFileURL(resolved).href)) as { default?: Ts } & Ts;
        return mod.default ?? mod;
    } catch {
        return null;
    }
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
 * Extracts a route's `export const metadata = { … }` if it's a static object literal, returning the
 * statically-evaluable subset (dynamic `generateMetadata` and computed values are skipped). `null`
 * when the file has no static metadata.
 */
export function extractStaticMetadata(ts: Ts, filePath: string): Record<string, unknown> | null {
    let source: string;
    try {
        source = fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
        for (const decl of stmt.declarationList.declarations) {
            if (
                ts.isIdentifier(decl.name) &&
                decl.name.text === 'metadata' &&
                decl.initializer &&
                ts.isObjectLiteralExpression(decl.initializer)
            ) {
                return evalObject(ts, decl.initializer);
            }
        }
    }
    return null;
}

/**
 * Build-only plugin that statically pre-renders per-route HTML for SEO. After the bundle is written,
 * it takes the built shell (`index.html`), and for each static route bakes that route's
 * `metadata` (merged over the site-wide `seo` defaults) into a `<route>/index.html` so a JS-less
 * crawler hitting the route gets correct per-page tags. Dynamic (`generateMetadata`) and `:param`
 * routes are skipped (no data at build) and fall back to the client-rendered shell.
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
            const ts = await loadTypeScript(cfg.root);

            const routes = scanRoutes(cfg.routesAbsDir).filter(
                (r) => r.slot === undefined && !r.intercept && !/[:*]/.test(r.pattern),
            );
            for (const route of routes) {
                const metadata = ts ? extractStaticMetadata(ts, route.file) : null;
                const html = injectSeoHtml(shell, routeSeo(cfg.seo, metadata, route.pattern));
                const target =
                    route.pattern === '/'
                        ? shellPath
                        : path.join(outDir, route.pattern.replace(/^\//, ''), 'index.html');
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, html);
            }
        },
    };
}

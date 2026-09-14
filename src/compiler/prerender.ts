import fs from 'node:fs';
import path from 'node:path';

import { parseSync, type Expression, type ObjectExpression } from 'oxc-parser';
import type { Plugin } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { patternToBracketFile, scanRoutes, staticSectionPattern } from './routes.js';
import { injectSeoHtml, routeSeo } from './seo.js';

const UNRESOLVED = Symbol('unresolved');

/** Read literals without executing route code or loading a compiler API. */
function evalNode(node: Expression): unknown {
    switch (node.type) {
        case 'Literal':
            return 'regex' in node || 'bigint' in node ? UNRESOLVED : node.value;
        case 'TemplateLiteral':
            return node.expressions.length === 0 ? node.quasis[0].value.cooked : UNRESOLVED;
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
        case 'TSNonNullExpression':
        case 'TSTypeAssertion':
        case 'ParenthesizedExpression':
            return evalNode(node.expression);
        case 'UnaryExpression': {
            const value = evalNode(node.argument);
            if (typeof value !== 'number') return UNRESOLVED;
            return node.operator === '-' ? -value : node.operator === '+' ? value : UNRESOLVED;
        }
        case 'ArrayExpression': {
            const values: unknown[] = [];
            for (const element of node.elements) {
                if (!element || element.type === 'SpreadElement') return UNRESOLVED;
                const value = evalNode(element);
                if (value === UNRESOLVED) return UNRESOLVED;
                values.push(value);
            }
            return values;
        }
        case 'ObjectExpression':
            return evalObject(node);
        default:
            return UNRESOLVED;
    }
}

function evalObject(node: ObjectExpression): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
        if (
            property.type !== 'Property' ||
            property.computed ||
            property.method ||
            property.kind !== 'init'
        )
            continue;
        const key =
            property.key.type === 'Identifier'
                ? property.key.name
                : property.key.type === 'Literal' && typeof property.key.value === 'string'
                  ? property.key.value
                  : null;
        if (key === null) continue;
        const value = evalNode(property.value);
        if (value !== UNRESOLVED) {
            Object.defineProperty(result, key, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }
    return result;
}

function staticExports(filePath: string, names: readonly string[]): Record<string, unknown> {
    let source: string;
    try {
        source = fs.readFileSync(filePath, 'utf8');
    } catch {
        return {};
    }
    const parsed = parseSync(filePath, source);
    if (parsed.errors.length)
        throw new Error(
            `Cannot parse route ${filePath}: ${parsed.errors.map((e) => e.message).join('; ')}`,
        );
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const statement of parsed.program.body) {
        if (
            statement.type !== 'ExportNamedDeclaration' ||
            statement.declaration?.type !== 'VariableDeclaration'
        )
            continue;
        for (const declaration of statement.declaration.declarations) {
            if (
                declaration.id.type !== 'Identifier' ||
                !names.includes(declaration.id.name) ||
                !declaration.init
            )
                continue;
            if (Object.hasOwn(result, declaration.id.name)) continue;
            const value = evalNode(declaration.init);
            if (value !== UNRESOLVED) result[declaration.id.name] = value;
        }
    }
    return result;
}

/** Extract statically evaluable exported objects, ignoring dynamic expressions. */
export function extractStaticExports(
    filePath: string,
    names: readonly string[],
): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [name, value] of Object.entries(staticExports(filePath, names))) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            Object.defineProperty(result, name, { value, enumerable: true });
        }
    }
    return result;
}

export function extractStaticMetadata(filePath: string): Record<string, unknown> | null {
    return extractStaticExports(filePath, ['metadata']).metadata ?? null;
}

export function exportsTrue(filePath: string, name: string): boolean {
    return staticExports(filePath, [name])[name] === true;
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
        closeBundle() {
            if (!cfg.seo) return;
            const outDir = path.resolve(cfg.root, cfg.outDir);
            const shellPath = path.join(outDir, 'index.html');
            if (!fs.existsSync(shellPath)) return;
            const shell = fs.readFileSync(shellPath, 'utf8');
            // Stash the clean built shell (asset tags, no per-route SEO yet) so the post-build SSG
            // pass bakes dynamic routes from it rather than from this file once it's been overwritten
            // with the `/` route's head (which would duplicate canonical/og tags).
            fs.writeFileSync(path.join(cfg.toilDir, 'shell.html'), shell);

            const routes = scanRoutes(cfg.routesAbsDir).filter(
                (r) => r.slot === undefined && !r.intercept,
            );
            for (const route of routes) {
                const isDynamic = /[:*]/.test(route.pattern);
                // Edge SSR routes must not be shadowed by static bracket templates.
                if (isDynamic && exportsTrue(route.file, 'ssr')) continue;
                const metadata = extractStaticMetadata(route.file);
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

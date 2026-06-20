/**
 * Build-time orchestration for edge SSR: render each opted-in route to a
 * template-with-holes and emit the artifacts the edge + guest consume.
 *
 * The deterministic core (`extractRouteTemplate`, `injectIntoShell`,
 * `writeTemplateArtifacts`) is unit-tested with controlled components; the
 * `extractTemplates` driver loads real route + layout modules through a short-
 * lived Vite SSR server (the same pattern as `ssg.ts`).
 *
 * A route opts in with `export const ssr = true`. Its page + layout chain are
 * rendered under the loader-data provider with sample data, in sentinel mode;
 * the result is spliced into the built shell's `#root`, stripped to a `.tmpl`,
 * and written alongside the binary `.slots` manifest and the generated AS
 * `Slot` enum + `HASH`. A route (or layout) that throws under static markup
 * (e.g. it uses router hooks outside the supported subset) is skipped with a
 * warning and falls back to pure client rendering.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { type ComponentType, type Context, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { findLayout, findSpecialChain } from './generate.js';
import { scanRoutes } from './routes.js';
import { generateSlotsModule } from './ssr-codegen.js';
import {
    assignSlotIds,
    coherenceHash,
    encodeSlots,
    type Extracted,
    extractFromHtml,
} from './template.js';
import { createViteConfig } from './vite.js';

/** Marker element the client `mount` looks for to switch to `hydrateRoot`. */
const SSR_MARKER = '<template id="__toil_ssr"></template>';
const ROOT_DIV = '<div id="root"></div>';

export interface RouteRenderInput {
    /** File-safe route name (the `<name>.tmpl` stem). */
    name: string;
    Page: ComponentType;
    /** Layout chain, OUTERMOST first (root layout, then nested). */
    layouts: ComponentType<{ children?: ReactNode }>[];
    /** Sample loader data provided via the loader context during the render. */
    loaderData: unknown;
    /** The client's `LoaderDataContext` (loaded via the SSR module graph so it
     * is the same instance the page's `useLoaderData` reads). */
    loaderContext: Context<unknown> | null;
    /** The markers' build switch (same module instance the page imports). */
    setSsrBuild: (on: boolean) => void;
    /** The built HTML shell (with hashed script tags) to splice into. */
    shell: string;
    /** React's `createElement` from the SAME instance the page imports (the Vite
     * SSR graph), so element creation and the components' hooks share one React.
     * Defaults to the compiler's own React when omitted (unit tests). Mixing two
     * React copies leaves the hook dispatcher null ("Cannot read properties of
     * null (reading 'useRef')"). */
    createElement?: typeof createElement;
    /** `renderToStaticMarkup` paired with {@link createElement}'s React. */
    renderToStaticMarkup?: typeof renderToStaticMarkup;
}

export interface TemplateArtifacts {
    name: string;
    tmpl: Buffer;
    /** Binary `.slots` manifest for the Rust host. */
    slotsBin: Buffer;
    /** Generated AssemblyScript `Slot` enum + `HASH` module source. */
    slotsModule: string;
    hash: Buffer;
    slotCount: number;
}

/** Build the route element tree: layouts (outermost first) wrapping the page,
 * under the loader-data provider. The Suspense/RoutePage wrappers the client
 * adds contribute no DOM, so this reproduces the client's markup. */
export function assembleRouteElement(
    Page: ComponentType,
    layouts: ComponentType<{ children?: ReactNode }>[],
    loaderData: unknown,
    loaderContext: Context<unknown> | null,
    h: typeof createElement = createElement,
): ReactNode {
    let node: ReactNode = h(Page);
    if (loaderContext) {
        node = h(loaderContext.Provider, { value: loaderData }, node);
    }
    for (let i = layouts.length - 1; i >= 0; i--) {
        node = h(layouts[i], null, node);
    }
    return node;
}

/** Splice the rendered route HTML into the shell's `#root` and add the SSR
 * marker so the client hydrates rather than client-renders. */
export function injectIntoShell(shell: string, routeHtml: string): string {
    if (!shell.includes(ROOT_DIV)) {
        throw new Error('toil ssr: built shell has no empty <div id="root"></div> to splice into');
    }
    return shell.replace(ROOT_DIV, `<div id="root">${routeHtml}</div>${SSR_MARKER}`);
}

/** Render one route to its template artifacts (pure given its inputs). */
export function extractRouteTemplate(input: RouteRenderInput): TemplateArtifacts {
    const h = input.createElement ?? createElement;
    const render = input.renderToStaticMarkup ?? renderToStaticMarkup;
    const element = assembleRouteElement(
        input.Page,
        input.layouts,
        input.loaderData,
        input.loaderContext,
        h,
    );
    input.setSsrBuild(true);
    let routeHtml: string;
    try {
        routeHtml = render(element);
    } finally {
        input.setSsrBuild(false);
    }
    const full = injectIntoShell(input.shell, routeHtml);
    const extracted: Extracted = extractFromHtml(full);
    const ids = assignSlotIds(extracted.slots);
    const hash = coherenceHash(extracted.tmpl, extracted.slots);
    return {
        name: input.name,
        tmpl: extracted.tmpl,
        slotsBin: encodeSlots(extracted.tmpl.length, hash, extracted.slots, ids),
        slotsModule: generateSlotsModule(input.name, extracted.slots, hash),
        hash,
        slotCount: extracted.slots.length,
    };
}

/** Write a route's `.tmpl` / `.slots` / `.slots.ts` into `ssrDir`. */
export function writeTemplateArtifacts(ssrDir: string, art: TemplateArtifacts): void {
    fs.mkdirSync(ssrDir, { recursive: true });
    fs.writeFileSync(path.join(ssrDir, `${art.name}.tmpl`), art.tmpl);
    fs.writeFileSync(path.join(ssrDir, `${art.name}.slots`), art.slotsBin);
    fs.writeFileSync(path.join(ssrDir, `${art.name}.slots.ts`), art.slotsModule);
}

/** A file-safe, identifier-ish name for a route pattern (`/u/:name` -> `u_name`). */
export function routeTemplateName(pattern: string): string {
    const n = pattern.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return n.length > 0 ? n : 'index';
}

/** Synthesize a sample param set for a pattern's dynamic segments. */
function sampleParams(pattern: string): Record<string, string> {
    const params: Record<string, string> = {};
    for (const m of pattern.matchAll(/[:*]+([A-Za-z0-9_]+)/g)) {
        params[m[1]] = 'sample';
    }
    return params;
}

interface RouteModule {
    default: ComponentType;
    ssr?: boolean;
    loader?: (args: { params: Record<string, string>; searchParams: URLSearchParams }) => unknown;
}

/**
 * Render every `export const ssr = true` route to `<outDir>/_ssr/<name>.{tmpl,
 * slots,slots.ts}` + a `templates.json` index, and copy the `.tmpl`/`.slots`
 * into the edge host bundle at `hosts/<host>/_tmpl/`. Returns the patterns
 * generated. Skips (with a warning) any route that throws under static markup.
 */
export async function extractTemplates(
    cfg: ResolvedToilConfig,
    hostName = 'edge',
): Promise<string[]> {
    const routes = scanRoutes(cfg.routesAbsDir).filter((r) => r.slot === undefined && !r.intercept);
    if (routes.length === 0) return [];

    const outDir = path.resolve(cfg.root, cfg.outDir);
    const stashed = path.join(cfg.toilDir, 'shell.html');
    const shellPath = fs.existsSync(stashed) ? stashed : path.join(outDir, 'index.html');
    if (!fs.existsSync(shellPath)) return [];
    const shell = fs.readFileSync(shellPath, 'utf8');

    const warn = (msg: string): void => {
        process.stderr.write(`  toil: SSR ${msg}\n`);
    };
    const server = await createServer({
        ...(await createViteConfig(cfg)),
        server: { middlewareMode: true, hmr: false },
        appType: 'custom',
        logLevel: 'silent',
    });

    const client = (await server.ssrLoadModule('toiljs/client')) as unknown as {
        __setSsrBuild: (on: boolean) => void;
        LoaderDataContext: Context<unknown>;
    };

    // Install the ambient `Toil` global (+ registered pages / transitions) exactly
    // as the client entry does, by evaluating the generated globals module. Without
    // it, any layout or component using `Toil` (e.g. `<Toil.Head>`, `<Toil.Link>`)
    // throws "Toil is not defined" during extraction, so the route is silently
    // skipped and falls back to client rendering.
    const globalsModule = path.join(cfg.toilDir, 'globals.ts');
    if (fs.existsSync(globalsModule)) {
        await server.ssrLoadModule(globalsModule);
    }

    // Render with the SAME React the components import. Vite externalizes react
    // (CommonJS) for SSR and resolves it from the app root, so resolve it the same
    // way (from cfg.root) rather than using the compiler's own copy. Two React
    // copies leave the hook dispatcher null, so a layout/component hook
    // (`useLocation` -> `useRef`) throws. (`ssrLoadModule('react')` can't be used:
    // Vite's SSR runner cannot evaluate the CJS module -> "module is not defined".)
    const appRequire = createRequire(path.join(cfg.root, 'package.json'));
    const react = appRequire('react') as { createElement: typeof createElement };
    const reactDomServer = appRequire('react-dom/server') as {
        renderToStaticMarkup: typeof renderToStaticMarkup;
    };

    const ssrDir = path.join(outDir, '_ssr');
    const hostsTmplDir = path.join(cfg.root, 'hosts', hostName, '_tmpl');
    const generated: string[] = [];
    const index: { route: string; name: string; hash: string }[] = [];

    try {
        for (const r of routes) {
            let mod: RouteModule;
            try {
                mod = (await server.ssrLoadModule(r.file)) as unknown as RouteModule;
            } catch (err) {
                warn(`skipped ${r.pattern} (${err instanceof Error ? err.message : String(err)})`);
                continue;
            }
            if (mod.ssr !== true) continue;

            try {
                const params = sampleParams(r.pattern);
                const loaderData =
                    typeof mod.loader === 'function'
                        ? await mod.loader({ params, searchParams: new URLSearchParams() })
                        : undefined;

                const layoutFiles = [
                    ...(findLayout(cfg) ? [findLayout(cfg)!] : []),
                    ...findSpecialChain(cfg, r.file, 'layout', false),
                ];
                const layouts: ComponentType<{ children?: ReactNode }>[] = [];
                for (const lf of layoutFiles) {
                    const lm = (await server.ssrLoadModule(lf)) as unknown as {
                        default: ComponentType<{ children?: ReactNode }>;
                    };
                    layouts.push(lm.default);
                }

                const name = routeTemplateName(r.pattern);
                const art = extractRouteTemplate({
                    name,
                    Page: mod.default,
                    layouts,
                    loaderData,
                    loaderContext: client.LoaderDataContext,
                    setSsrBuild: client.__setSsrBuild,
                    shell,
                    createElement: react.createElement,
                    renderToStaticMarkup: reactDomServer.renderToStaticMarkup,
                });
                writeTemplateArtifacts(ssrDir, art);
                fs.mkdirSync(hostsTmplDir, { recursive: true });
                fs.copyFileSync(
                    path.join(ssrDir, `${name}.tmpl`),
                    path.join(hostsTmplDir, `${name}.tmpl`),
                );
                fs.copyFileSync(
                    path.join(ssrDir, `${name}.slots`),
                    path.join(hostsTmplDir, `${name}.slots`),
                );
                index.push({ route: r.pattern, name, hash: art.hash.toString('hex') });
                generated.push(r.pattern);
            } catch (err) {
                warn(
                    `skipped ${r.pattern} (render failed: ${
                        err instanceof Error ? err.message : String(err)
                    }) — falls back to client rendering`,
                );
            }
        }
    } finally {
        await server.close();
    }

    if (generated.length > 0) {
        fs.mkdirSync(ssrDir, { recursive: true });
        fs.writeFileSync(path.join(ssrDir, 'templates.json'), JSON.stringify(index, null, 2));
        process.stdout.write(
            `  ✓ extracted ${String(generated.length)} SSR template${
                generated.length === 1 ? '' : 's'
            }\n`,
        );
    }
    return generated;
}

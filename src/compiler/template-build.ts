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
 *
 * The `Slot` enum + `HASH` is also what the SERVER `render` imports, so it must
 * exist BEFORE the server compiles. The build therefore runs the render in two
 * passes: a slots PRE-PASS (`extractServerSlots`, before the server build) emits
 * the server-importable `<server>/_ssr/<name>.slots.ts` so toilscript can compile
 * the `render`; the FINAL pass (`extractTemplates`, after the Vite client build)
 * rewrites it against the real built shell so the `HASH` is authoritative, and
 * reports whether it rotated so the caller can recompile the server once. This is
 * what makes a clean build need ZERO hand-maintained slots.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { type ComponentType, type Context, createElement, type ReactNode, Suspense } from 'react';
import { renderToString } from 'react-dom/server';
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
import { extractStaticMetadata, loadTypeScript } from './prerender.js';
import { escapeAttr, escapeHtml, injectSeoHtml, routeSeo, type SeoConfig } from './seo.js';

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
    /** `renderToString` paired with {@link createElement}'s React. We use it (NOT
     * `renderToStaticMarkup`) because hydration needs the `<!-- -->` text-node
     * boundary markers it emits, so `hydrateRoot` can align "text + hole" runs. */
    renderToString?: typeof renderToString;
    /** React's `Suspense` from the SAME instance as {@link createElement}, so the
     * Suspense dehydration markers (`<!--$-->`) emitted match the client's. */
    Suspense?: typeof Suspense;
    /** Site SEO config. When set, this route's resolved SEO (site defaults overlaid with the
     * route's static `metadata`) is baked into the template `<head>`, so an SSR route serves the
     * same per-page title/description/og (incl og:image) a crawler gets from `<route>/index.html`. */
    seo?: SeoConfig | null;
    /** The route's static `export const metadata` (extracted at build), overlaid on the site SEO. */
    metadata?: Record<string, unknown> | null;
    /** The route pattern, used for the canonical / `og:url`. */
    pattern?: string;
    /** Drains the component-level head (`useHead`/`useTitle`/`<Head>`) collected during this route's
     * render, so it's baked into the SSR `<head>` too. From `toiljs/client`'s `__drainSsrHead`. */
    drainSsrHead?: () => SsrHead;
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

/** Build the route element tree, mirroring the client Router so `renderToString`
 * emits the SAME Suspense dehydration markers (`<!--$-->`) `hydrateRoot` expects.
 * The page sits under the loader-data provider inside a route `Suspense`, and EACH
 * layout (outermost first) gets its own `Suspense`, exactly as `renderMatched` +
 * `Router` wrap them. Without these markers the client's Suspense boundaries have
 * nothing to align to and hydration regenerates the whole tree. (The ErrorBoundary
 * / context wrappers the client adds emit no DOM and no markers, so they are
 * omitted here.) The `Suspense` component must come from the SAME React as `h`. */
export function assembleRouteElement(
    Page: ComponentType,
    layouts: ComponentType<{ children?: ReactNode }>[],
    loaderData: unknown,
    loaderContext: Context<unknown> | null,
    h: typeof createElement = createElement,
    SuspenseComp: typeof Suspense = Suspense,
): ReactNode {
    let node: ReactNode = h(Page);
    if (loaderContext) {
        node = h(loaderContext.Provider, { value: loaderData }, node);
    }
    node = h(SuspenseComp, { fallback: null }, node); // route Suspense (mirrors RoutePage's boundary)
    for (let i = layouts.length - 1; i >= 0; i--) {
        node = h(SuspenseComp, { fallback: null }, h(layouts[i], null, node));
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

/**
 * React 19 auto-emits hoistable resource tags into `<head>` on the client (it
 * adds a `<link rel="preload">` for an `<img>`, and hoists `<title>` / `<meta>`),
 * but the string renderer emits them INLINE in the route fragment. Left in the
 * spliced `#root` template they would not appear in the client's hydrated `#root`
 * (the client puts them in `<head>`), so `hydrateRoot` reports a mismatch. Strip
 * them from the route fragment; the shell already carries the document head, and
 * the client re-adds its own resource hints. Only the fragment is stripped. */
function stripHoistedResourceTags(html: string): string {
    return html
        .replace(/<link\b[^>]*>/gi, '')
        .replace(/<meta\b[^>]*>/gi, '')
        .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '');
}

/** The resolved component-level head drained from the client head manager during an SSR-build render
 * (structurally `ResolvedHead` from `toiljs/client`). */
interface SsrHead {
    title?: string;
    meta: { name?: string; property?: string; content: string; [attr: string]: string | undefined }[];
    link: { rel: string; href: string; [attr: string]: string | undefined }[];
}

/** Render one head `<meta>`/`<link>` to an HTML tag, marked `data-toil-head` so the client head
 * manager owns it on hydration (it removes + re-emits `[data-toil-head]` tags on every navigation,
 * exactly as it does for the tags it adds at runtime — so there's no duplication or stale leak). */
function headTag(tag: 'meta' | 'link', attrs: Record<string, string | undefined>): string {
    const pairs = Object.entries(attrs)
        .filter((e): e is [string, string] => e[1] !== undefined)
        .map(([k, v]) => `${k}="${escapeAttr(v)}"`);
    return `    <${tag} data-toil-head ${pairs.join(' ')} />`;
}

/**
 * Bake the route's component-level head (layout `<Head>` + a page's `useHead`/`useTitle`, collected
 * during render) into the document head: the title when the route's static `metadata` set none (the
 * component title outranks the site default), plus any `<meta>`/`<link>` the route SEO didn't already
 * carry — so the server HTML reflects the SAME head the client computes, not just the static metadata.
 */
function injectComponentHead(
    html: string,
    head: SsrHead,
    routeMetadata: Record<string, unknown> | null,
): string {
    let out = html;
    if (head.title !== undefined && (routeMetadata === null || routeMetadata.title === undefined)) {
        const tag = `<title>${escapeHtml(head.title)}</title>`;
        out = /<title>[\s\S]*?<\/title>/i.test(out)
            ? out.replace(/<title>[\s\S]*?<\/title>/i, tag)
            : out.replace(/<\/head>/i, `    ${tag}\n  </head>`);
    }
    const tags: string[] = [];
    for (const m of head.meta) {
        const key =
            m.name !== undefined
                ? `name="${m.name}"`
                : m.property !== undefined
                  ? `property="${m.property}"`
                  : null;
        if (key === null || out.includes(key)) continue; // already covered by the route SEO
        tags.push(headTag('meta', m));
    }
    for (const l of head.link) {
        if (out.includes(`href="${l.href}"`)) continue;
        tags.push(headTag('link', l));
    }
    if (tags.length > 0) {
        out = out.includes('</head>')
            ? out.replace(/<\/head>/i, `${tags.join('\n')}\n  </head>`)
            : `${tags.join('\n')}\n${out}`;
    }
    return out;
}

/** Render one route to its template artifacts (pure given its inputs). */
export function extractRouteTemplate(input: RouteRenderInput): TemplateArtifacts {
    const h = input.createElement ?? createElement;
    const render = input.renderToString ?? renderToString;
    const SuspenseComp = input.Suspense ?? Suspense;
    const element = assembleRouteElement(
        input.Page,
        input.layouts,
        input.loaderData,
        input.loaderContext,
        h,
        SuspenseComp,
    );
    // Clear any specs leaked from a previously-failed route render before collecting this route's.
    input.drainSsrHead?.();
    input.setSsrBuild(true);
    let routeHtml: string;
    try {
        routeHtml = render(element);
    } finally {
        input.setSsrBuild(false);
    }
    // The component-level head (layout <Head> + page useHead/useTitle) was collected during the render
    // above; drain it now, per route, so it can be baked alongside the static SEO.
    const componentHead: SsrHead = input.drainSsrHead?.() ?? { meta: [], link: [] };
    let full = injectIntoShell(input.shell, stripHoistedResourceTags(routeHtml));
    // Bake the route's resolved SEO into the template <head>, mirroring the static prerender
    // (prerender.ts / ssg.ts) so an `ssr=true` route serves the SAME per-page metadata (title,
    // description, canonical, og:* incl og:image, twitter, jsonLd) a crawler gets from the static
    // <route>/index.html — which the dynamic SSR template otherwise shadows at request time. Runs on
    // the FULL spliced document (injectSeoHtml's <title>/</head> regexes need the shell head, not the
    // stripped fragment) and BEFORE extractFromHtml so the coherence hash covers the baked head.
    if (input.seo) {
        full = injectSeoHtml(full, routeSeo(input.seo, input.metadata ?? null, input.pattern ?? '/'));
    }
    // Then add the component-level head (a layout's <Head>, a page's useHead/useTitle) that the static
    // metadata export + site SEO didn't already cover, so the server HTML carries the same head the
    // client computes.
    full = injectComponentHead(full, componentHead, input.metadata ?? null);
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

/**
 * The server source dir (where toilscript-compiled modules live): the dir of the first toilconfig
 * entry, else `<root>/server`. Mirrors the same resolution in `emails.ts` (`_emails.ts` lives here).
 */
function serverDir(root: string): string {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, 'toilconfig.json'), 'utf8')) as {
            entries?: unknown;
        };
        const first = Array.isArray(cfg.entries)
            ? cfg.entries.find((e): e is string => typeof e === 'string')
            : undefined;
        if (first) return path.dirname(path.resolve(root, first));
    } catch {
        // fall through to the default
    }
    return path.join(root, 'server');
}

/**
 * The build-owned dir that holds the GENERATED, server-importable `<name>.slots.ts` modules
 * (the `Slot` enum + `HASH` the guest `render` imports). It sits inside the server source tree so
 * toilscript compiles it, named `_ssr` to match the generated `_emails.ts` convention, and is
 * gitignored + regenerated every build — never hand-edited. The server `render` imports
 * `./_ssr/<name>.slots`.
 */
export function serverSlotsDir(root: string): string {
    return path.join(serverDir(root), '_ssr');
}

/**
 * (Re)write the generated `<server>/_ssr/<name>.slots.ts` module(s) the server `render` imports.
 * Returns the map of `name -> module source` actually on disk afterwards, so the caller can detect
 * whether a later authoritative extraction changed the `HASH` and a server recompile is needed.
 * Only rewrites a file whose content actually changed (keeps mtimes stable for the dev watcher).
 */
export function writeServerSlotsModules(
    root: string,
    modules: { name: string; slotsModule: string }[],
): Map<string, string> {
    const dir = serverSlotsDir(root);
    const written = new Map<string, string>();
    if (modules.length === 0) return written;
    fs.mkdirSync(dir, { recursive: true });
    for (const m of modules) {
        const file = path.join(dir, `${m.name}.slots.ts`);
        let prev: string | null = null;
        try {
            prev = fs.readFileSync(file, 'utf8');
        } catch {
            // first build for this route: no prior module
        }
        if (prev !== m.slotsModule) fs.writeFileSync(file, m.slotsModule);
        written.set(m.name, m.slotsModule);
    }
    return written;
}

/** A rendered SSR route plus the artifacts the build emits for it. */
interface RenderedRoute {
    pattern: string;
    art: TemplateArtifacts;
}

/**
 * Spin up a short-lived Vite SSR server, render every `export const ssr = true` route under its
 * layout chain (with sample loader data, in sentinel mode) against `shell`, and return the
 * per-route artifacts. Shared by the pre-pass (`extractServerSlots`, slots only) and the final
 * `extractTemplates` (full artifacts). A route (or layout) that throws under static markup is
 * skipped with a warning and omitted from the result, so it falls back to client rendering.
 */
async function renderSsrRoutes(cfg: ResolvedToilConfig, shell: string): Promise<RenderedRoute[]> {
    const routes = scanRoutes(cfg.routesAbsDir).filter((r) => r.slot === undefined && !r.intercept);
    if (routes.length === 0) return [];

    // Load TypeScript once (same as prerender.ts) to read each route's static `metadata` for the
    // SSR <head>. Only needed when the project configures SEO.
    const ts = cfg.seo ? await loadTypeScript(cfg.root) : null;

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
        __setSsrLocation: (path: string | null) => void;
        __drainSsrHead: () => SsrHead;
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
    const react = appRequire('react') as {
        createElement: typeof createElement;
        Suspense: typeof Suspense;
    };
    const reactDomServer = appRequire('react-dom/server') as {
        renderToString: typeof renderToString;
    };

    const rendered: RenderedRoute[] = [];
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

                const rootLayout = findLayout(cfg);
                const layoutFiles = [
                    ...(rootLayout ? [rootLayout] : []),
                    ...findSpecialChain(cfg, r.file, 'layout', false),
                ];
                const layouts: ComponentType<{ children?: ReactNode }>[] = [];
                for (const lf of layoutFiles) {
                    const lm = (await server.ssrLoadModule(lf)) as unknown as {
                        default: ComponentType<{ children?: ReactNode }>;
                    };
                    layouts.push(lm.default);
                }

                // The route's static `metadata` export (same static-AST read prerender.ts uses, so
                // the SSR head matches the static <route>/index.html exactly). generateMetadata is
                // dynamic and skipped here, as in prerender/ssg.
                const metadata = ts ? extractStaticMetadata(ts, r.file) : null;

                const name = routeTemplateName(r.pattern);
                // Tell location hooks which URL this template is for, so a NavLink's active
                // class / aria-current render as they will on the client at this route (else
                // the `/` default mismatches on hydration). Cleared in `finally`.
                client.__setSsrLocation(samplePath(r.pattern));
                const art = extractRouteTemplate({
                    name,
                    Page: mod.default,
                    layouts,
                    loaderData,
                    loaderContext: client.LoaderDataContext,
                    setSsrBuild: client.__setSsrBuild,
                    drainSsrHead: client.__drainSsrHead,
                    shell,
                    createElement: react.createElement,
                    renderToString: reactDomServer.renderToString,
                    Suspense: react.Suspense,
                    seo: cfg.seo,
                    metadata,
                    pattern: r.pattern,
                });
                // An imported image asset is resolved through the dev SSR server to a dev-only URL
                // (/@imagetools/..., /@fs/..., /src/...) that has no production path, so baking it into
                // a frozen .tmpl would 404 in the built app. Rather than ship a broken template, skip
                // the route (it client-renders, where the asset resolves correctly) and tell the author
                // to use a public/ string path for images on SSR routes.
                const devAsset = /(?:src|href)="\/(?:@imagetools|@fs|@id|src)\//.exec(
                    art.tmpl.toString('utf8'),
                );
                if (devAsset) {
                    warn(
                        `skipped ${r.pattern}: an imported asset resolves to a dev-only URL ` +
                            `("${devAsset[0]}…") with no production path — reference images on SSR routes ` +
                            `via a public/ string path (e.g. src="/images/x.webp") — falling back to client rendering`,
                    );
                    continue;
                }
                rendered.push({ pattern: r.pattern, art });
            } catch (err) {
                warn(
                    `skipped ${r.pattern} (render failed: ${
                        err instanceof Error ? err.message : String(err)
                    }) — falls back to client rendering`,
                );
            } finally {
                client.__setSsrLocation(null);
            }
        }
    } finally {
        await server.close();
    }
    return rendered;
}

/**
 * Resolve the HTML shell to splice routes into. The authoritative shell is the BUILT (post-Vite)
 * `index.html`, whose hashed `<script>`/`<link>` tags are part of the template and therefore the
 * coherence `HASH`. `preferBuilt` (the final extraction) demands it; the slots PRE-PASS (which runs
 * before Vite) falls back to the previous build's shell when present (so an unchanged rebuild's
 * pre-pass `HASH` already matches the final one and no server recompile is needed), and finally to
 * the un-built `.toil/index.html` template on a first clean build. Returns `null` when no shell
 * exists at all (no client build yet and no template), so the caller no-ops.
 */
function resolveShell(cfg: ResolvedToilConfig, preferBuilt: boolean): string | null {
    const outDir = path.resolve(cfg.root, cfg.outDir);
    const builtIndex = path.join(outDir, 'index.html');
    const stashed = path.join(cfg.toilDir, 'shell.html');
    const templateIndex = path.join(cfg.toilDir, 'index.html');
    const order = preferBuilt
        ? [stashed, builtIndex]
        : // Pre-pass (before Vite): use a prior build's shell if it exists so the HASH is stable
          // across rebuilds; otherwise the generated (un-built) template, which still yields the
          // correct Slot ids (the final pass reconciles the HASH).
          [builtIndex, stashed, templateIndex];
    for (const p of order) {
        if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    }
    return null;
}

/**
 * SLOTS PRE-PASS (runs BEFORE the server build): render every `ssr = true` route to its `Slot`
 * enum + `HASH` and write the server-importable `<server>/_ssr/<name>.slots.ts` module(s), so the
 * server `render` can import them when toilscript compiles it. On a clean build no `.slots.ts`
 * exists yet, so this is what bootstraps it; on a rebuild it refreshes them. The `Slot` ids are
 * always correct (they depend only on the route's hole structure); the `HASH` is final only when a
 * prior build's shell is reused, so the final `extractTemplates` reconciles it (and the caller
 * recompiles the server if it rotated). Returns the modules written keyed by route name.
 */
export async function extractServerSlots(cfg: ResolvedToilConfig): Promise<Map<string, string>> {
    const shell = resolveShell(cfg, false);
    if (shell === null) return new Map();
    const rendered = await renderSsrRoutes(cfg, shell);
    return writeServerSlotsModules(
        cfg.root,
        rendered.map((r) => ({ name: r.art.name, slotsModule: r.art.slotsModule })),
    );
}

/** One SSR route's in-memory dev template: the spliceable `.tmpl` plus its
 * top-level slot insertion points (numeric id -> byte offset), parsed from the
 * `.slots` manifest. Used by the dev server to serve SSR without a prod build. */
export interface DevSsrTemplate {
    pattern: string;
    name: string;
    tmpl: Buffer;
    entries: { id: number; offset: number }[];
}

/**
 * Render every `ssr = true` route against the given (live, Vite-transformed) dev
 * `shell` into an in-memory template + slot offsets, for the dev server to splice
 * the guest `render` values into. Unlike {@link extractTemplates} this has NO
 * side effects (it writes nothing and does not touch `server/_ssr` or the host
 * bundle); the dev server builds together with the guest, so there is no hash to
 * reconcile. Returns `[]` when no route opts in.
 */
export async function extractDevSsrTemplates(
    cfg: ResolvedToilConfig,
    shell: string,
): Promise<DevSsrTemplate[]> {
    const rendered = await renderSsrRoutes(cfg, shell);
    return rendered.map(({ pattern, art }) => {
        // Parse the `.slots` manifest: 46-byte header (n_slots at offset 44),
        // then 8-byte entries (u32 offset, u16 id, u8 kind, u8 reserved).
        const bin = art.slotsBin;
        const n = bin.readUInt16LE(44);
        const entries: { id: number; offset: number }[] = [];
        let o = 46;
        for (let i = 0; i < n; i++) {
            entries.push({ offset: bin.readUInt32LE(o), id: bin.readUInt16LE(o + 4) });
            o += 8;
        }
        return { pattern, name: art.name, tmpl: art.tmpl, entries };
    });
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

/** The concrete pathname for a route pattern, dynamic segments filled with the same `sample`
 * value {@link sampleParams} uses, so location-dependent markup renders consistently. Static
 * routes return their pattern unchanged. */
function samplePath(pattern: string): string {
    return pattern.replace(/[:*]+([A-Za-z0-9_]+)/g, 'sample');
}

interface RouteModule {
    default: ComponentType;
    ssr?: boolean;
    loader?: (args: { params: Record<string, string>; searchParams: URLSearchParams }) => unknown;
}

/** The outcome of the final {@link extractTemplates} pass. */
export interface ExtractResult {
    /** The route patterns that produced a template. */
    readonly generated: string[];
    /**
     * Whether the AUTHORITATIVE `<server>/_ssr/<name>.slots.ts` module(s) just written differ from
     * the ones the server was already compiled against (`priorServerSlots`). True means the `HASH`
     * (or `Slot` ids) rotated after the server build, so the server must be recompiled to bake the
     * correct `HASH` (otherwise the host rejects the guest's stale hash as a deploy skew).
     */
    readonly serverSlotsChanged: boolean;
}

/**
 * FINAL pass (runs AFTER the client/Vite build): render every `export const ssr = true` route to
 * `<outDir>/_ssr/<name>.{tmpl,slots,slots.ts}` + a `templates.json` index, copy the `.tmpl`/`.slots`
 * into the edge host bundle at `hosts/<host>/_tmpl/`, AND (re)write the server-importable
 * `<server>/_ssr/<name>.slots.ts` module(s) — now against the real built shell, so the `HASH` is
 * authoritative. Skips (with a warning) any route that throws under static markup.
 *
 * `priorServerSlots` is the module map the slots PRE-PASS wrote (what the server was compiled
 * against); compared against the authoritative modules here to report whether a server recompile is
 * needed (see {@link ExtractResult.serverSlotsChanged}).
 */
export async function extractTemplates(
    cfg: ResolvedToilConfig,
    hostName = 'edge',
    priorServerSlots: Map<string, string> = new Map(),
): Promise<ExtractResult> {
    const shell = resolveShell(cfg, true);
    if (shell === null) return { generated: [], serverSlotsChanged: false };

    const rendered = await renderSsrRoutes(cfg, shell);

    const outDir = path.resolve(cfg.root, cfg.outDir);
    const ssrDir = path.join(outDir, '_ssr');
    const hostsTmplDir = path.join(cfg.root, 'hosts', hostName, '_tmpl');
    const generated: string[] = [];
    const index: { route: string; name: string; hash: string }[] = [];

    for (const { pattern, art } of rendered) {
        writeTemplateArtifacts(ssrDir, art);
        fs.mkdirSync(hostsTmplDir, { recursive: true });
        fs.copyFileSync(
            path.join(ssrDir, `${art.name}.tmpl`),
            path.join(hostsTmplDir, `${art.name}.tmpl`),
        );
        fs.copyFileSync(
            path.join(ssrDir, `${art.name}.slots`),
            path.join(hostsTmplDir, `${art.name}.slots`),
        );
        index.push({ route: pattern, name: art.name, hash: art.hash.toString('hex') });
        generated.push(pattern);
    }

    // Write the AUTHORITATIVE server-importable slots module(s) (the real built-shell HASH) and
    // detect whether they changed since the pre-pass the server was compiled against.
    const authoritative = writeServerSlotsModules(
        cfg.root,
        rendered.map((r) => ({ name: r.art.name, slotsModule: r.art.slotsModule })),
    );
    let serverSlotsChanged = false;
    for (const [name, mod] of authoritative) {
        if (priorServerSlots.get(name) !== mod) serverSlotsChanged = true;
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
    return { generated, serverSlotsChanged };
}

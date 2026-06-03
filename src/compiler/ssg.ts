/**
 * Build-time SSG for dynamic routes. After the client bundle is written, this loads each dynamic
 * route that exports `generateStaticParams`, enumerates its concrete URLs, runs the route's
 * `generateMetadata` per URL, and bakes a `<url>/index.html` (so JS-less crawlers get per-page tags)
 * plus a `sitemap.xml` entry. Opt-in: a route without `generateStaticParams` is untouched, and the
 * whole pass is skipped when no such route exists or `seo` is unconfigured. Build-only.
 *
 * Runs from `build()` (not the prerender Vite plugin) so it can reuse `createViteConfig` without the
 * `vite.ts` <-> `prerender.ts` import cycle; it spins up a short-lived SSR server to load route source.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createServer } from 'vite';

import { type ResolvedToilConfig } from './config.js';
import { scanRoutes } from './routes.js';
import { injectSeoHtml, routeSeo, sitemapXml } from './seo.js';
import { createViteConfig } from './vite.js';

type StaticParams = Record<string, string | string[]>;

interface RouteModule {
    generateStaticParams?: () => StaticParams[] | Promise<StaticParams[]>;
    generateMetadata?: (args: {
        params: StaticParams;
        searchParams: URLSearchParams;
        data: unknown;
    }) => unknown;
    loader?: (args: { params: StaticParams; searchParams: URLSearchParams }) => unknown;
    metadata?: Record<string, unknown>;
}

/** Substitutes `:param` / `*catch-all` segments in a route pattern with concrete param values. */
export function fillPattern(pattern: string, params: StaticParams): string {
    return pattern.replace(/[:*]([A-Za-z0-9_]+)/g, (_m, name: string) => {
        const value = params[name] as string | string[] | undefined;
        if (Array.isArray(value)) return value.join('/');
        return value ?? '';
    });
}

/** Coerces an unknown module export to a typed Metadata-ish record, or null. */
function asMetadata(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Pre-renders every dynamic route that opts in via `generateStaticParams`. Bakes per-URL HTML into
 * `outDir` and rewrites `sitemap.xml` with the generated URLs. Returns the list of generated URLs.
 */
export async function prerenderStaticParams(cfg: ResolvedToilConfig): Promise<string[]> {
    if (!cfg.seo) return [];
    const outDir = path.resolve(cfg.root, cfg.outDir);
    // Prefer the clean shell stashed by the prerender plugin (no per-route SEO baked in); fall back
    // to the built index.html.
    const stashed = path.join(cfg.toilDir, 'shell.html');
    const shellPath = fs.existsSync(stashed) ? stashed : path.join(outDir, 'index.html');
    if (!fs.existsSync(shellPath)) return [];

    const allRoutes = scanRoutes(cfg.routesAbsDir);
    const dynamic = allRoutes.filter(
        (r) => r.slot === undefined && !r.intercept && /[:*]/.test(r.pattern),
    );
    if (dynamic.length === 0) return [];

    const shell = fs.readFileSync(shellPath, 'utf8');
    const server = await createServer({
        ...(await createViteConfig(cfg)),
        server: { middlewareMode: true, hmr: false },
        appType: 'custom',
        logLevel: 'silent',
    });

    const generated: string[] = [];
    const warn = (msg: string): void => {
        process.stderr.write(`  toil: SSG ${msg}\n`);
    };
    try {
        for (const route of dynamic) {
            let mod: RouteModule;
            try {
                mod = (await server.ssrLoadModule(route.file)) as RouteModule;
            } catch (err) {
                warn(`skipped ${route.pattern} (${err instanceof Error ? err.message : String(err)})`);
                continue;
            }
            if (typeof mod.generateStaticParams !== 'function') continue;
            const paramSets = await mod.generateStaticParams();
            for (const params of paramSets) {
                const url = fillPattern(route.pattern, params);
                let metadata: Record<string, unknown> | null = null;
                try {
                    if (typeof mod.generateMetadata === 'function') {
                        const searchParams = new URLSearchParams();
                        const data =
                            typeof mod.loader === 'function'
                                ? await mod.loader({ params, searchParams })
                                : undefined;
                        metadata = asMetadata(await mod.generateMetadata({ params, searchParams, data }));
                    } else if (mod.metadata) {
                        metadata = asMetadata(mod.metadata);
                    }
                } catch (err) {
                    warn(`metadata failed for ${url} (${err instanceof Error ? err.message : String(err)})`);
                }
                const html = injectSeoHtml(shell, routeSeo(cfg.seo, metadata, url));
                const target = path.join(outDir, url.replace(/^\//, ''), 'index.html');
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, html);
                generated.push(url);
            }
        }
    } finally {
        await server.close();
    }

    if (generated.length > 0) {
        const sitemap = sitemapXml(cfg.seo, allRoutes, generated);
        if (sitemap) fs.writeFileSync(path.join(outDir, 'sitemap.xml'), sitemap);
        process.stdout.write(
            `  ✓ prerendered ${String(generated.length)} dynamic route${generated.length === 1 ? '' : 's'}\n`,
        );
    }
    return generated;
}

import type { ScannedRoute } from './routes.js';

/**
 * Build-time SEO for the (otherwise JS-only) SPA: bakes site-level metadata into the HTML `<head>`
 * so JS-less crawlers and AI bots see real tags, and generates `robots.txt`, `sitemap.xml`, and
 * `llms.txt`. All pure string builders here; `generate.ts` wires them into the build output.
 */

/**
 * OpenGraph defaults baked into the HTML, read by Facebook, Discord, Slack, LinkedIn, GitHub, and
 * most link-preview crawlers. `image` should be an absolute URL (≥1200×630 for a large card).
 */
export interface SeoOpenGraph {
    readonly title?: string;
    readonly description?: string;
    /** `og:type`, e.g. `'website'` or `'article'`. */
    readonly type?: string;
    readonly siteName?: string;
    /** `og:locale`, e.g. `'en_US'`. */
    readonly locale?: string;
    /** `og:image`, the preview image (absolute URL). */
    readonly image?: string;
    /** `og:image:alt`. */
    readonly imageAlt?: string;
    /** `og:image:width` in px (helps Facebook/LinkedIn render without a re-fetch). */
    readonly imageWidth?: number;
    /** `og:image:height` in px. */
    readonly imageHeight?: number;
    /** `og:image:type`, e.g. `'image/png'`. */
    readonly imageType?: string;
}

/** Twitter / X card. Unset fields fall back to the OpenGraph / top-level values. */
export interface SeoTwitter {
    /** `'summary'` | `'summary_large_image'` | … Defaults by whether an image is present. */
    readonly card?: string;
    readonly site?: string;
    readonly creator?: string;
    readonly title?: string;
    readonly description?: string;
    readonly image?: string;
    readonly imageAlt?: string;
}

/** A `robots.txt` group. */
export interface RobotsRule {
    readonly userAgent?: string | readonly string[];
    readonly allow?: readonly string[];
    readonly disallow?: readonly string[];
}

/** `robots.txt` configuration. */
export interface RobotsConfig {
    readonly rules?: readonly RobotsRule[];
    /** How to treat known AI crawlers (GPTBot, ClaudeBot, Google-Extended, …). Default `'allow'`. */
    readonly ai?: 'allow' | 'disallow';
    /** Explicit `Sitemap:` URL (defaults to `<url>/sitemap.xml` when `seo.url` is set). */
    readonly sitemap?: string;
}

/** A page listed in `llms.txt`. */
export interface LlmsPage {
    readonly title: string;
    readonly url: string;
    readonly description?: string;
}

/** `llms.txt` configuration (the AI-crawler guidance file). */
export interface LlmsConfig {
    readonly title?: string;
    readonly summary?: string;
    /** Free-form instructions for AI/LLM crawlers. */
    readonly instructions?: string;
    /** Key pages; defaults to the site's static routes. */
    readonly pages?: readonly LlmsPage[];
}

/** Build-time SEO configuration (under `client.seo`). */
export interface SeoConfig {
    /** Absolute site base URL, e.g. `https://toil.dev`, required for `sitemap.xml` and canonical/OG URLs. */
    readonly url?: string;
    /** Default document title baked into the HTML. */
    readonly title?: string;
    /** Default meta description. */
    readonly description?: string;
    /** Default robots directive, e.g. `'index, follow'`. */
    readonly robotsMeta?: string;
    /** `<meta name="theme-color">`, also the accent color of Discord/Slack link embeds. */
    readonly themeColor?: string;
    readonly openGraph?: SeoOpenGraph;
    readonly twitter?: SeoTwitter;
    /** Facebook-specific tags (`fb:app_id`). OpenGraph above covers the rest of the FB card. */
    readonly facebook?: { readonly appId?: string };
    /** JSON-LD structured data injected as `<script type="application/ld+json">`. */
    readonly jsonLd?: Record<string, unknown> | readonly Record<string, unknown>[];
    /** Origins to `<link rel="preconnect">` (early connection hints). */
    readonly preconnect?: readonly string[];
    /** Origins to `<link rel="dns-prefetch">`. */
    readonly dnsPrefetch?: readonly string[];
    /** `robots.txt` generation; `false` to skip. */
    readonly robots?: RobotsConfig | false;
    /** `sitemap.xml` generation; defaults to on when `url` is set. */
    readonly sitemap?: boolean;
    /** `llms.txt` (AI guidance) generation; `false` to skip, `true`/object to configure. */
    readonly llms?: LlmsConfig | boolean;
}

/** Known AI / LLM crawler user-agents, for explicit allow/disallow in `robots.txt`. */
const AI_CRAWLERS: readonly string[] = [
    'GPTBot',
    'OAI-SearchBot',
    'ChatGPT-User',
    'ClaudeBot',
    'Claude-Web',
    'anthropic-ai',
    'Google-Extended',
    'PerplexityBot',
    'CCBot',
    'Applebot-Extended',
    'Bytespider',
    'Amazonbot',
    'Meta-ExternalAgent',
];

/** Escapes a value for use inside a double-quoted HTML attribute (prevents attribute-breakout XSS). */
function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
/** Escapes a value for HTML text content (e.g. `<title>`, XML text). */
export function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * Serializes a value for embedding in an inline `<script>` (JSON-LD). Escapes `<`, `>`, and `&`,
 * which neutralizes `</script>` and `<!--` (the only HTML-significant sequences inside a script),
 * so attacker-controlled data can't break out of the script element.
 */
function escapeJsonForScript(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}
function meta(attrs: Record<string, string | number | undefined>): string {
    const pairs = Object.entries(attrs)
        .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
        .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`);
    return `    <meta ${pairs.join(' ')} />`;
}

/** Joins a base URL and a route path into a clean absolute URL. */
export function joinUrl(base: string, path: string): string {
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/$/, '') || base;
}

/** Static (parameter-free) route patterns, the ones that can be listed in a sitemap. */
function staticPaths(routes: readonly ScannedRoute[]): string[] {
    return routes
        .filter((r) => r.slot === undefined && !r.intercept && !/[:*]/.test(r.pattern))
        .map((r) => r.pattern)
        .sort();
}

/** The site-level `<head>` fragment baked into the built HTML (title is handled separately). */
export function seoHeadTags(seo: SeoConfig): string {
    const lines: string[] = [];
    if (seo.description !== undefined)
        lines.push(meta({ name: 'description', content: seo.description }));
    if (seo.robotsMeta !== undefined) lines.push(meta({ name: 'robots', content: seo.robotsMeta }));
    if (seo.themeColor !== undefined)
        lines.push(meta({ name: 'theme-color', content: seo.themeColor }));
    if (seo.url !== undefined)
        lines.push(`    <link rel="canonical" href="${escapeAttr(seo.url)}" />`);

    // OpenGraph (also drives Facebook, Discord, Slack, LinkedIn, GitHub previews).
    const og = seo.openGraph;
    const ogTitle = og?.title ?? seo.title;
    const ogDesc = og?.description ?? seo.description;
    if (ogTitle !== undefined) lines.push(meta({ property: 'og:title', content: ogTitle }));
    if (ogDesc !== undefined) lines.push(meta({ property: 'og:description', content: ogDesc }));
    lines.push(meta({ property: 'og:type', content: og?.type ?? 'website' }));
    if (seo.url !== undefined) lines.push(meta({ property: 'og:url', content: seo.url }));
    if (og?.siteName !== undefined)
        lines.push(meta({ property: 'og:site_name', content: og.siteName }));
    if (og?.locale !== undefined) lines.push(meta({ property: 'og:locale', content: og.locale }));
    if (og?.image !== undefined) {
        lines.push(meta({ property: 'og:image', content: og.image }));
        if (og.imageAlt !== undefined)
            lines.push(meta({ property: 'og:image:alt', content: og.imageAlt }));
        if (og.imageType !== undefined)
            lines.push(meta({ property: 'og:image:type', content: og.imageType }));
        if (og.imageWidth !== undefined)
            lines.push(meta({ property: 'og:image:width', content: og.imageWidth }));
        if (og.imageHeight !== undefined) {
            lines.push(meta({ property: 'og:image:height', content: og.imageHeight }));
        }
    }
    if (seo.facebook?.appId !== undefined) {
        lines.push(meta({ property: 'fb:app_id', content: seo.facebook.appId }));
    }

    // Twitter / X card. Unset fields fall back to OpenGraph / top-level values.
    const tw = seo.twitter;
    if (tw) {
        const twImage = tw.image ?? og?.image;
        const card = tw.card ?? (twImage !== undefined ? 'summary_large_image' : 'summary');
        lines.push(meta({ name: 'twitter:card', content: card }));
        if (tw.site !== undefined) lines.push(meta({ name: 'twitter:site', content: tw.site }));
        if (tw.creator !== undefined)
            lines.push(meta({ name: 'twitter:creator', content: tw.creator }));
        const twTitle = tw.title ?? ogTitle;
        const twDesc = tw.description ?? ogDesc;
        if (twTitle !== undefined) lines.push(meta({ name: 'twitter:title', content: twTitle }));
        if (twDesc !== undefined)
            lines.push(meta({ name: 'twitter:description', content: twDesc }));
        if (twImage !== undefined) lines.push(meta({ name: 'twitter:image', content: twImage }));
        const twImageAlt = tw.imageAlt ?? og?.imageAlt;
        if (twImageAlt !== undefined)
            lines.push(meta({ name: 'twitter:image:alt', content: twImageAlt }));
    }

    for (const origin of seo.preconnect ?? []) {
        lines.push(`    <link rel="preconnect" href="${escapeAttr(origin)}" />`);
    }
    for (const origin of seo.dnsPrefetch ?? []) {
        lines.push(`    <link rel="dns-prefetch" href="${escapeAttr(origin)}" />`);
    }
    if (seo.jsonLd !== undefined) {
        lines.push(
            `    <script type="application/ld+json">${escapeJsonForScript(seo.jsonLd)}</script>`,
        );
    }
    return lines.join('\n');
}

/** The default document title to bake into the HTML, if any. */
export function seoTitle(seo: SeoConfig): string | undefined {
    return seo.title;
}

/**
 * Bakes the SEO `<head>` into an HTML document: replaces the existing `<title>` and `description`
 * meta (so they aren't duplicated) and inserts the rest before `</head>`. Used for the shell and,
 * per route, by the prerenderer.
 */
export function injectSeoHtml(html: string, seo: SeoConfig): string {
    let out = html;
    const title = seoTitle(seo);
    if (title !== undefined) {
        const tag = `<title>${escapeHtml(title)}</title>`;
        out = /<title>[\s\S]*?<\/title>/i.test(out)
            ? out.replace(/<title>[\s\S]*?<\/title>/i, tag)
            : out.replace(/<\/head>/i, `    ${tag}\n  </head>`);
    }
    if (seo.description !== undefined) {
        out = out.replace(/[ \t]*<meta\s+name=["']description["'][^>]*>\s*\n?/i, '');
    }
    const tags = seoHeadTags(seo);
    if (tags) {
        out = out.includes('</head>')
            ? out.replace(/<\/head>/i, `${tags}\n  </head>`)
            : `${tags}\n${out}`;
    }
    return out;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Overlays a route's extracted `metadata` (title/description/openGraph/…) onto the site-wide
 * {@link SeoConfig}, and points the canonical/`og:url` at the route's own URL. The result is what
 * the prerenderer bakes into that route's HTML, per-file metadata winning over the site defaults.
 */
export function routeSeo(
    seo: SeoConfig,
    metadata: Record<string, unknown> | null,
    pattern: string,
): SeoConfig {
    const routeUrl = seo.url !== undefined ? joinUrl(seo.url, pattern) : undefined;
    if (!metadata) return { ...seo, url: routeUrl };
    const og = asRecord(metadata.openGraph);
    return {
        ...seo,
        url: asString(metadata.canonical) ?? routeUrl,
        title: asString(metadata.title) ?? seo.title,
        description: asString(metadata.description) ?? seo.description,
        robotsMeta: asString(metadata.robots) ?? seo.robotsMeta,
        themeColor: asString(metadata.themeColor) ?? seo.themeColor,
        openGraph: {
            ...seo.openGraph,
            title: asString(og.title) ?? asString(metadata.title) ?? seo.openGraph?.title,
            description:
                asString(og.description) ??
                asString(metadata.description) ??
                seo.openGraph?.description,
            type: asString(og.type) ?? seo.openGraph?.type,
            image: asString(og.image) ?? seo.openGraph?.image,
            imageAlt: asString(og.imageAlt) ?? seo.openGraph?.imageAlt,
            siteName: asString(og.siteName) ?? seo.openGraph?.siteName,
        },
    };
}

/** `robots.txt` contents. */
export function robotsTxt(seo: SeoConfig): string {
    if (seo.robots === false) return '';
    const cfg: RobotsConfig = seo.robots ?? {};
    const blocks: string[] = [];

    const rules = cfg.rules ?? [{ userAgent: '*', allow: ['/'] }];
    for (const rule of rules) {
        const agents = rule.userAgent === undefined ? ['*'] : [rule.userAgent].flat();
        const lines = agents.map((a) => `User-agent: ${a}`);
        for (const p of rule.allow ?? []) lines.push(`Allow: ${p}`);
        for (const p of rule.disallow ?? []) lines.push(`Disallow: ${p}`);
        blocks.push(lines.join('\n'));
    }

    const aiDirective = cfg.ai === 'disallow' ? 'Disallow: /' : 'Allow: /';
    blocks.push(
        ['# AI / LLM crawlers', ...AI_CRAWLERS.map((a) => `User-agent: ${a}\n${aiDirective}`)].join(
            '\n\n',
        ),
    );

    const sitemap =
        cfg.sitemap ?? (seo.url !== undefined ? joinUrl(seo.url, 'sitemap.xml') : undefined);
    if (sitemap !== undefined) blocks.push(`Sitemap: ${sitemap}`);

    return blocks.join('\n\n') + '\n';
}

/**
 * `sitemap.xml` from the site's static routes plus any `extra` concrete paths (e.g. SSG URLs from
 * `generateStaticParams`); requires `seo.url`, empty when no base URL. `extra` is deduped against the
 * static paths.
 */
export function sitemapXml(
    seo: SeoConfig,
    routes: readonly ScannedRoute[],
    extra: readonly string[] = [],
): string {
    if (seo.url === undefined || seo.sitemap === false) return '';
    const paths = [...new Set([...staticPaths(routes), ...extra])];
    const urls = paths
        .map((p) => `  <url><loc>${escapeHtml(joinUrl(seo.url ?? '', p))}</loc></url>`)
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** `llms.txt` (AI-crawler guidance) contents; empty when disabled. */
export function llmsTxt(seo: SeoConfig, routes: readonly ScannedRoute[]): string {
    if (seo.llms === false) return '';
    const cfg: LlmsConfig = seo.llms === true || seo.llms === undefined ? {} : seo.llms;
    const title = cfg.title ?? seo.title ?? seo.url ?? 'Site';
    const out: string[] = [`# ${title}`];
    const summary = cfg.summary ?? seo.description;
    if (summary !== undefined) out.push(`\n> ${summary}`);
    if (cfg.instructions !== undefined) out.push(`\n${cfg.instructions}`);

    const pages: readonly LlmsPage[] =
        cfg.pages ??
        (seo.url !== undefined
            ? staticPaths(routes).map(
                  (p): LlmsPage => ({
                      title: p === '/' ? 'Home' : p,
                      url: joinUrl(seo.url ?? '', p),
                  }),
              )
            : []);
    if (pages.length) {
        out.push('\n## Pages\n');
        for (const page of pages) {
            out.push(
                `- [${page.title}](${page.url})${page.description !== undefined ? `: ${page.description}` : ''}`,
            );
        }
    }
    return out.join('\n') + '\n';
}

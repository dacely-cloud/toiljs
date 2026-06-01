import type { HtmlTagDescriptor, Logger, Plugin } from 'vite';

import { type ResolvedToilConfig } from './config.js';

/**
 * Build-time font optimization. Bundled font files (`@font-face` `url(...)` imports) are emitted +
 * hashed by Vite, but without a hint the browser only discovers them after parsing CSS, delaying
 * text paint. This injects a `<link rel="preload" as="font" crossorigin>` for each bundled font so
 * it loads in parallel with the CSS, and logs what it preloaded (mirrors the image-optimization log).
 */
const FONT_RE = /\.(woff2|woff|ttf|otf)$/i;
const FONT_TYPE: Record<string, string> = {
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf',
};

function kb(bytes: number): string {
    return `${(bytes / 1000).toFixed(2)} kB`;
}

/** Builds the `<link rel="preload">` head tags for a set of bundled font file names. */
export function fontPreloadTags(fileNames: readonly string[], base: string): HtmlTagDescriptor[] {
    const prefix = base.endsWith('/') ? base : `${base}/`;
    return fileNames
        .filter((name) => FONT_RE.test(name))
        .map((name) => {
            const ext = name.split('.').pop()?.toLowerCase() ?? '';
            return {
                tag: 'link',
                attrs: {
                    rel: 'preload',
                    as: 'font',
                    type: FONT_TYPE[ext] ?? `font/${ext}`,
                    href: `${prefix}${name}`,
                    crossorigin: '',
                },
                injectTo: 'head',
            };
        });
}

/** Build-only plugin that preloads bundled fonts and logs them. Disabled by `client.fonts: false`. */
export function fontPreloadPlugin(cfg: ResolvedToilConfig): Plugin {
    let logger: Logger | undefined;
    let logged = false;
    return {
        name: 'toil:font-preload',
        apply: 'build',
        configResolved(config) {
            logger = config.logger;
        },
        transformIndexHtml: {
            order: 'post',
            handler(html, ctx) {
                const bundle = ctx.bundle ?? {};
                const fonts = Object.values(bundle).filter(
                    (file) => file.type === 'asset' && FONT_RE.test(file.fileName),
                );
                if (fonts.length === 0) return html;

                // Log once (the same template's HTML is transformed per emitted page).
                if (!logged && logger) {
                    logged = true;
                    logger.info('');
                    logger.info(`  ✓ preloaded ${String(fonts.length)} font${fonts.length === 1 ? '' : 's'}`);
                    for (const file of fonts) {
                        const size =
                            file.type === 'asset' && typeof file.source !== 'string'
                                ? kb(file.source.byteLength)
                                : '';
                        logger.info(`    → ${file.fileName}  ${size}`);
                    }
                }

                return {
                    html,
                    tags: fontPreloadTags(
                        fonts.map((f) => f.fileName),
                        cfg.base,
                    ),
                };
            },
        },
    };
}

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Plugin } from 'vite';

import { type ResolvedToilConfig } from './config.js';

/** SHA-384 Subresource-Integrity token (`sha384-<base64>`) for a local file, or `null` if it can't
 *  be read. Memoized per absolute path (the same asset is referenced by many baked pages). */
function computeSri(absPath: string, cache: Map<string, string | null>): string | null {
    const cached = cache.get(absPath);
    if (cached !== undefined) return cached;
    let sri: string | null;
    try {
        sri = `sha384-${createHash('sha384').update(fs.readFileSync(absPath)).digest('base64')}`;
    } catch {
        sri = null;
    }
    cache.set(absPath, sri);
    return sri;
}

/** Resolve a tag URL to a path relative to `outDir`, or `null` if it is not a local build asset
 *  (an absolute scheme, protocol-relative, `data:`, or a traversal are all skipped). */
function toLocalAsset(url: string, base: string): string | null {
    const clean = url.split('?')[0].split('#')[0];
    // scheme (`https:`, `data:`), protocol-relative (`//cdn`), or empty -> not ours to hash.
    if (clean === '' || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
    let rel = clean;
    if (base && base !== '/' && rel.startsWith(base)) rel = rel.slice(base.length);
    else if (rel.startsWith('/')) rel = rel.slice(1);
    else if (rel.startsWith('./')) rel = rel.slice(2);
    if (rel === '' || rel.includes('..')) return null;
    return rel;
}

/**
 * Add Subresource Integrity to every LOCAL `<script src>`, `<link rel="modulepreload" href>`, and
 * `<link rel="stylesheet" href>` in `html`: an `integrity="sha384-…"` computed from the asset's
 * bytes plus `crossorigin="anonymous"` (required for the browser to verify + a no-op same-origin).
 * External URLs, inline scripts, non-script/style links, and tags that already carry `integrity`
 * are left untouched. Vite content-hashes these assets, so the integrity is stable and matches the
 * immutable-cached bytes the edge serves.
 */
export function injectSri(html: string, outDir: string, base: string): string {
    const cache = new Map<string, string | null>();
    return html.replace(/<(script|link)\b([^>]*)>/gi, (full, tag: string, rawAttrs: string) => {
        if (/\bintegrity\s*=/i.test(rawAttrs)) return full; // already integrity-tagged
        const selfClose = /\/\s*$/.test(rawAttrs);
        const attrs = rawAttrs.replace(/\s*\/\s*$/, '');
        const isScript = tag.toLowerCase() === 'script';
        if (!isScript) {
            const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
            if (rel !== 'stylesheet' && rel !== 'modulepreload') return full;
        }
        const attr = isScript ? 'src' : 'href';
        const url = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attrs)?.[1];
        if (url === undefined) return full; // inline script or no url
        const rel = toLocalAsset(url, base);
        if (rel === null) return full;
        const sri = computeSri(path.join(outDir, rel), cache);
        if (sri === null) return full;
        const cross = /\bcrossorigin\b/i.test(attrs) ? '' : ' crossorigin="anonymous"';
        return `<${tag}${attrs} integrity="${sri}"${cross}${selfClose ? ' /' : ''}>`;
    });
}

/**
 * Build-only plugin: after the bundle is written, rewrites the built shell (`outDir/index.html`) so
 * every local script/stylesheet/modulepreload carries an `integrity`. It runs in `closeBundle`
 * (assets are on disk, so real bytes are hashed) and is registered BEFORE the prerender / SSR-
 * template passes, which bake per-route HTML, bracket templates, and the SSR `.tmpl` FROM this
 * shell -- so every emitted page inherits SRI and the `.tmpl` coherence hash covers it. Build-only:
 * the dev server serves un-hashed modules straight from Vite, where SRI would be meaningless.
 */
export function sriPlugin(cfg: ResolvedToilConfig): Plugin {
    return {
        name: 'toil:sri',
        apply: 'build',
        closeBundle() {
            const outDir = path.resolve(cfg.root, cfg.outDir);
            const shell = path.join(outDir, 'index.html');
            if (!fs.existsSync(shell)) return;
            const html = fs.readFileSync(shell, 'utf8');
            const out = injectSri(html, outDir, cfg.base);
            if (out !== html) fs.writeFileSync(shell, out);
        },
    };
}

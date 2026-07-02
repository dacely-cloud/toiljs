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
        // `(?<![\w-])` (not `\b`) so a hyphenated decoy attr never counts as the real one: `\bintegrity`
        // matches inside `data-integrity` (would wrongly skip us), `\bsrc` inside `data-src` (would hash
        // the wrong URL). The guard requires the attr name to start at a real attribute boundary.
        if (/(?<![\w-])integrity\s*=/i.test(rawAttrs)) return full; // already integrity-tagged
        const selfClose = /\/\s*$/.test(rawAttrs);
        const attrs = rawAttrs.replace(/\s*\/\s*$/, '');
        const isScript = tag.toLowerCase() === 'script';
        if (!isScript) {
            const rel = /(?<![\w-])rel\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
            if (rel !== 'stylesheet' && rel !== 'modulepreload') return full;
        }
        const attr = isScript ? 'src' : 'href';
        const url = new RegExp(`(?<![\\w-])${attr}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attrs)?.[1];
        if (url === undefined) return full; // inline script or no url
        const rel = toLocalAsset(url, base);
        if (rel === null) return full;
        const sri = computeSri(path.join(outDir, rel), cache);
        if (sri === null) return full;
        const cross = /(?<![\w-])crossorigin(?![\w-])/i.test(attrs) ? '' : ' crossorigin="anonymous"';
        return `<${tag}${attrs} integrity="${sri}"${cross}${selfClose ? ' /' : ''}>`;
    });
}

/**
 * Build an `<script type="importmap">` tag whose `integrity` section maps every emitted JS chunk
 * (`assets/*.js`) to its sha384. Tag-level SRI only protects the ENTRY script: the rest of the
 * module graph -- static imports (the react vendor chunk) and lazily `import()`ed route chunks --
 * is fetched by the module loader, which does NOT inherit the tag's integrity. The import map's
 * `integrity` field is the platform mechanism that extends verification to those fetches; browsers
 * without support ignore the key (progressive enhancement, nothing breaks). Returns `null` when
 * there are no chunks.
 */
export function buildImportMapIntegrity(
    outDir: string,
    base: string,
    cache: Map<string, string | null> = new Map(),
): string | null {
    const assetsDir = path.join(outDir, 'assets');
    let names: string[];
    try {
        names = fs.readdirSync(assetsDir).filter((n) => n.endsWith('.js'));
    } catch {
        return null;
    }
    const prefix = base.endsWith('/') ? base : `${base}/`;
    const integrity: Record<string, string> = {};
    for (const name of names.sort()) {
        const sri = computeSri(path.join(assetsDir, name), cache);
        if (sri !== null) integrity[`${prefix}assets/${name}`] = sri;
    }
    if (Object.keys(integrity).length === 0) return null;
    return `<script type="importmap">${JSON.stringify({ integrity })}</script>`;
}

/** Insert the import-map tag where it takes effect: right after `<head>` (an import map must be
 *  parsed before any module load). Falls back to prepending before the first `<script`. No-op if
 *  an integrity import map is already present (idempotent on an already-processed shell). */
export function injectImportMap(html: string, importMapTag: string): string {
    if (html.includes('<script type="importmap">{"integrity"')) return html;
    const head = /<head[^>]*>/i.exec(html);
    if (head !== null) {
        const at = head.index + head[0].length;
        return `${html.slice(0, at)}\n    ${importMapTag}${html.slice(at)}`;
    }
    const script = html.indexOf('<script');
    if (script !== -1) return `${html.slice(0, script)}${importMapTag}\n${html.slice(script)}`;
    return html;
}

/**
 * Build-only plugin: after the bundle is written, rewrites the built shell (`outDir/index.html`) so
 * (a) every local script/stylesheet/modulepreload TAG carries an `integrity`, and (b) an import map
 * `integrity` section covers every emitted JS chunk, so the FULL module graph -- the entry's static
 * imports and every dynamically `import()`ed route chunk -- is verified, not just the entry tag. It
 * runs in `closeBundle` (assets are on disk, so real bytes are hashed) and is registered BEFORE the
 * prerender / SSR-template passes, which bake per-route HTML, bracket templates, and the SSR `.tmpl`
 * FROM this shell -- so every emitted page inherits both and the `.tmpl` coherence hash covers them.
 * Build-only: the dev server serves un-hashed modules straight from Vite, where SRI is meaningless.
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
            const cache = new Map<string, string | null>();
            let out = injectSri(html, outDir, cfg.base);
            const importMap = buildImportMapIntegrity(outDir, cfg.base, cache);
            if (importMap !== null) out = injectImportMap(out, importMap);
            if (out !== html) fs.writeFileSync(shell, out);
        },
    };
}

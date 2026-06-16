/**
 * Build-time email pipeline: compile `emails/*.tsx` React components into a
 * generated AssemblyScript module the server WASM uses to send mail.
 *
 * Why build-time: email clients run NO JavaScript and strip `<style>`/external
 * CSS, and the edge server is WASM (no React at send time). So each email is
 * rendered to STATIC, inline-CSS HTML once at build, with `{{token}}` holes
 * where component props were read; the edge fills those holes per send via the
 * `EmailTemplate` global (see `server/globals/email.ts`) and calls `email_send`.
 *
 * Per-send data is therefore FIELD SUBSTITUTION only (`{{name}}`, `{{code}}`) --
 * a build-time `{items.map(...)}` or conditional bakes into the output, it does
 * not re-run per send. Plenty for transactional / 2FA / confirmation email.
 *
 * The dynamic fields are discovered without parsing types: the component is
 * rendered with a Proxy whose every prop read returns the literal `{{prop}}`
 * and records the name, so `({name}) => <h1>Hi {name}` renders `Hi {{name}}`
 * and we learn the field is `name`.
 */

import fs from 'node:fs';
import path from 'node:path';

import pc from 'picocolors';
import { createServer, type ViteDevServer } from 'vite';

import type { ResolvedToilConfig } from './config.js';
import { createViteConfig } from './vite.js';

/** What an `emails/*.tsx` module may export. `default` is the React component. */
interface EmailModule {
    default: unknown;
    /** Subject line, a token template (e.g. `'Welcome, {{name}}'`). Defaults to the name. */
    subject?: unknown;
    /** Optional plain-text body template; derived by stripping the HTML when absent. */
    text?: unknown;
    /** Optional dedup/abuse `purpose` tag; defaults to the email name lowercased. */
    purpose?: unknown;
}

/** One email rendered to its baked, token-holed parts. */
export interface RenderedEmail {
    name: string;
    subject: string;
    html: string;
    text: string;
    /** Sorted, unique `{{token}}` field names this email interpolates. */
    tokens: string[];
    purpose: string;
}

/** Keys React (or the renderer) reads on props that must never become tokens. */
const REACT_INTERNAL = new Set([
    'children',
    'key',
    'ref',
    '$$typeof',
    '__self',
    '__source',
    'toJSON',
    'prototype',
    'constructor',
    'then', // so a thenable check never tokenizes
]);

const TOKEN_RE = /\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}/g;

function extractTokens(s: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(s)) !== null) out.push(m[1]!);
    return out;
}

/**
 * A props object whose every (non-internal) read returns the literal `{{key}}`
 * and records `key`. Renders the component with placeholders and discovers the
 * field names in one pass — no TS type parsing.
 */
function tokenProps(seen: Set<string>): Record<string, unknown> {
    return new Proxy(
        {},
        {
            get(_target, key): unknown {
                if (typeof key !== 'string' || REACT_INTERNAL.has(key)) return undefined;
                seen.add(key);
                return `{{${key}}}`;
            },
        },
    );
}

/** Inline `<style>`/CSS into element `style=""` (juice) so email clients honor it.
 *  Optional: without juice installed, inline `style={{}}` props still work. */
async function inlineCss(html: string): Promise<string> {
    try {
        // Variable specifier: keep `juice` an OPTIONAL dependency (tsc won't
        // require its types, and a missing install falls back below).
        const specifier = 'juice';
        const mod = (await import(specifier)) as { default: (html: string) => string };
        return mod.default(html);
    } catch {
        return html;
    }
}

/** A crude HTML→text fallback for the plain-text part (better deliverability). */
function htmlToText(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<(?:br|\/p|\/h[1-6]|\/tr|\/div)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;|&#34;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&') // last: so "&amp;lt;" -> "&lt;", not "<"
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .trim();
}

/** Render one loaded email module to its baked parts, or `null` if it has no
 *  component. The default export must be a FUNCTION component (not a class) of
 *  its props: we call it directly with the token Proxy and render the element
 *  tree it returns. Going through `createElement(Component, proxy)` would not
 *  work -- React copies the config into a plain props object, so the component
 *  would never see the Proxy and every field would render empty. */
async function renderModule(
    name: string,
    mod: EmailModule,
    render: (el: unknown) => string,
    css = '',
): Promise<RenderedEmail | null> {
    if (typeof mod.default !== 'function') return null;

    const seen = new Set<string>();
    const component = mod.default as (props: unknown) => unknown;
    let html = render(component(tokenProps(seen)));
    // CSS the component imported (e.g. `import 'client/styles/email.css'`) is
    // prepended as a <style> block so it gets inlined into element style="" like
    // an inline block would -- under SSR a bare CSS import otherwise has no effect.
    html = await inlineCss(css ? `<style>${css}</style>${html}` : html);

    const subject = typeof mod.subject === 'string' ? mod.subject : name;
    const text = typeof mod.text === 'string' ? mod.text : htmlToText(html);
    const purpose =
        typeof mod.purpose === 'string' && mod.purpose.length > 0
            ? mod.purpose
            : name.toLowerCase();

    // Union the proxy-observed fields with any literal {{token}} authored in the
    // subject/text/html, so a hand-written placeholder is also a parameter.
    const tokens = [
        ...new Set([
            ...seen,
            ...extractTokens(subject),
            ...extractTokens(html),
            ...extractTokens(text),
        ]),
    ].sort();

    return { name, subject, html, text, tokens, purpose };
}

const CSS_RE = /\.(css|scss|sass|less|styl|pcss|postcss)(\?|$)/;

/**
 * Collect the CSS an email module transitively imports, as one string. Under SSR
 * a bare `import 'client/styles/email.css'` produces no output, so we walk the
 * Vite module graph from the email module, collect its CSS deps, and re-import
 * each with `?inline` (Vite then returns the processed CSS as the default export,
 * Tailwind/PostCSS included). The caller hands the result to `renderModule`,
 * which inlines it into the HTML. Best-effort: a CSS dep that can't be inlined is
 * skipped (the component's inline `style={{}}` props still render).
 */
export async function collectModuleCss(server: ViteDevServer, moduleId: string): Promise<string> {
    const seen = new Set<string>();
    const cssIds = new Set<string>();
    const visit = (id: string): void => {
        if (seen.has(id)) return;
        seen.add(id);
        const mod = server.moduleGraph.getModuleById(id);
        if (!mod) return;
        for (const dep of mod.importedModules) {
            const depId = dep.id ?? dep.url;
            if (!depId) continue;
            if (CSS_RE.test(depId)) cssIds.add(depId);
            else visit(depId);
        }
    };
    visit(moduleId);

    let css = '';
    for (const id of cssIds) {
        const base = id.split('?')[0] ?? id;
        try {
            const mod = (await server.ssrLoadModule(`${base}?inline`)) as { default?: unknown };
            if (typeof mod.default === 'string') css += mod.default + '\n';
        } catch {
            // skip a CSS dep we can't inline
        }
    }
    return css;
}

/**
 * Load one `emails/*.tsx` through `server` (SSR), collect any CSS it imports, and
 * render it to its baked, token-holed parts. Shared by the build/codegen pass and
 * the dev preview tool so both produce byte-identical output. Throws if the module
 * fails to load; returns `null` if it has no default-exported component.
 */
export async function renderEmailFile(
    server: ViteDevServer,
    emailsDir: string,
    file: string,
    render: (el: unknown) => string,
): Promise<RenderedEmail | null> {
    const name = toPascal(path.basename(file).replace(/\.(tsx|jsx)$/, ''));
    const filePath = path.join(emailsDir, file);
    const mod = (await server.ssrLoadModule(filePath)) as EmailModule;
    const node =
        server.moduleGraph.getModuleById(filePath) ??
        (await server.moduleGraph.getModuleByUrl(filePath));
    const css = node?.id ? await collectModuleCss(server, node.id) : '';
    return renderModule(name, mod, render, css);
}

/** `welcome-email` / `welcome_email` -> `WelcomeEmail`. */
export function toPascal(base: string): string {
    return base
        .split(/[-_\s.]+/)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join('');
}

/** Server source dir (where the generated module must live to be compiled): the
 *  dir of the first toilconfig entry, else `<root>/server`. */
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

/** A valid AS/JS string literal for `s` (double-quoted, fully escaped). */
function asLit(s: string): string {
    return JSON.stringify(s);
}

/** A unique, valid AS parameter identifier for `token`, avoiding the fixed
 *  `to`/`purpose` params, AS keywords, and earlier tokens. */
function paramName(token: string, used: Set<string>): string {
    const RESERVED = new Set(['to', 'purpose', 'class', 'function', 'new', 'this', 'type', 'in']);
    let p = token;
    while (used.has(p) || RESERVED.has(p)) p = p + '_';
    used.add(p);
    return p;
}

/** Codegen the `Emails` AssemblyScript module from the rendered set. */
function renderModuleSource(rendered: RenderedEmail[]): string {
    const out: string[] = [];
    out.push('// GENERATED by toiljs from emails/*.tsx -- DO NOT EDIT.');
    out.push('// Each email is rendered to static, inline-CSS HTML at build time;');
    out.push('// {{tokens}} are filled per send. `EmailTemplate`/`EmailStatus` are');
    out.push('// toiljs globals (server/globals/email.ts), so no import is needed.');
    out.push('');
    out.push('export namespace Emails {');
    for (const e of rendered) {
        out.push(`  export namespace ${e.name} {`);
        out.push(`    const SUBJECT: string = ${asLit(e.subject)};`);
        out.push(`    const TEXT: string = ${asLit(e.text)};`);
        out.push(`    const HTML: string = ${asLit(e.html)};`);
        const used = new Set<string>();
        const params = e.tokens.map((t) => ({ token: t, param: paramName(t, used) }));
        const sig = ['to: string']
            .concat(params.map((p) => `${p.param}: string`))
            .concat(`purpose: string = ${asLit(e.purpose)}`)
            .join(', ');
        out.push(
            `    /** Render and send this email to \`to\`. Returns the send's EmailStatus. */`,
        );
        out.push(`    export function send(${sig}): EmailStatus {`);
        out.push(`      const __v = new Map<string, string>();`);
        for (const p of params) out.push(`      __v.set(${asLit(p.token)}, ${p.param});`);
        out.push(`      return new EmailTemplate(SUBJECT, TEXT, HTML).send(to, __v, purpose);`);
        out.push(`    }`);
        out.push(`  }`);
    }
    out.push('}');
    return out.join('\n') + '\n';
}

const GENERATED_BASENAME = '_emails.ts';

function warn(msg: string): void {
    process.stderr.write(`  toil: emails ${msg}\n`);
}

/**
 * Render every `emails/*.tsx` and (re)write the generated `<server>/_emails.ts`
 * module, BEFORE the toilscript server build so it is compiled in. A no-op when
 * there is no `emails/` directory. Removes a stale generated module when the
 * directory becomes empty.
 */
export async function renderEmails(cfg: ResolvedToilConfig): Promise<void> {
    const emailsDir = path.join(cfg.root, 'emails');
    const generatedPath = path.join(serverDir(cfg.root), GENERATED_BASENAME);

    if (!fs.existsSync(emailsDir)) return;
    const files = fs
        .readdirSync(emailsDir)
        .filter((f) => /\.(tsx|jsx)$/.test(f))
        .sort();
    if (files.length === 0) {
        if (fs.existsSync(generatedPath)) fs.rmSync(generatedPath);
        return;
    }

    // React DOM is only needed when a project actually has emails; load it
    // lazily so a server-only project without emails never pays for it.
    const { renderToStaticMarkup } = await import('react-dom/server');

    const server = await createServer({
        ...(await createViteConfig(cfg)),
        server: { middlewareMode: true, hmr: false },
        appType: 'custom',
        logLevel: 'silent',
    });

    const rendered: RenderedEmail[] = [];
    try {
        for (const file of files) {
            try {
                const r = await renderEmailFile(
                    server,
                    emailsDir,
                    file,
                    renderToStaticMarkup as (el: unknown) => string,
                );
                if (r) rendered.push(r);
                else warn(`skipped ${file} (no default-exported component)`);
            } catch (err) {
                warn(`skipped ${file} (${err instanceof Error ? err.message : String(err)})`);
            }
        }
    } finally {
        await server.close();
    }

    if (rendered.length === 0) return;
    // Only (re)write when the output actually changed: an unconditional write
    // bumps the file's mtime every rebuild, which under `dev` would re-trigger
    // the watcher. (The watcher also ignores this file by name; this is belt-and-
    // suspenders and avoids needless work.)
    const next = renderModuleSource(rendered);
    const prev = fs.existsSync(generatedPath) ? fs.readFileSync(generatedPath, 'utf8') : null;
    if (prev === next) return;
    fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
    fs.writeFileSync(generatedPath, next);
    process.stdout.write(
        pc.green('  ✓ ') +
            pc.dim(
                `emails: generated ${String(rendered.length)} template${rendered.length === 1 ? '' : 's'} (${rendered
                    .map((r) => r.name)
                    .join(', ')})`,
            ) +
            '\n',
    );
}

// Exported for unit testing the pure render/codegen without a Vite server.
export const __test = { renderModule, renderModuleSource, tokenProps, htmlToText, toPascal };

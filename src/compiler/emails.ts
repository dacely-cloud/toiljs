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

import { createServer } from 'vite';

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
interface RenderedEmail {
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
): Promise<RenderedEmail | null> {
    if (typeof mod.default !== 'function') return null;

    const seen = new Set<string>();
    const component = mod.default as (props: unknown) => unknown;
    let html = render(component(tokenProps(seen)));
    html = await inlineCss(html);

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

/** `welcome-email` / `welcome_email` -> `WelcomeEmail`. */
function toPascal(base: string): string {
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
        out.push(`    /** Render and send this email to \`to\`. Returns the send's EmailStatus. */`);
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
            const name = toPascal(path.basename(file).replace(/\.(tsx|jsx)$/, ''));
            let mod: EmailModule;
            try {
                mod = (await server.ssrLoadModule(path.join(emailsDir, file))) as EmailModule;
            } catch (err) {
                warn(`skipped ${file} (${err instanceof Error ? err.message : String(err)})`);
                continue;
            }
            const r = await renderModule(name, mod, renderToStaticMarkup as (el: unknown) => string);
            if (r) rendered.push(r);
            else warn(`skipped ${file} (no default-exported component)`);
        }
    } finally {
        await server.close();
    }

    if (rendered.length === 0) return;
    fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
    fs.writeFileSync(generatedPath, renderModuleSource(rendered));
    process.stdout.write(
        `  ✓ emails: generated ${String(rendered.length)} template${rendered.length === 1 ? '' : 's'} (${rendered
            .map((r) => r.name)
            .join(', ')})\n`,
    );
}

// Exported for unit testing the pure render/codegen without a Vite server.
export const __test = { renderModule, renderModuleSource, tokenProps, htmlToText, toPascal };

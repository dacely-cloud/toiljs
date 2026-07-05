/**
 * Built-in auth email templates + their per-app OVERRIDE pipeline.
 *
 * The built-in auth controller (`server/auth/AuthController.ts`) sends three
 * transactional emails: the email-verification link, the password-reset link,
 * and the 2FA code. Their default subject/text/html live here as the single
 * source of truth. An app overrides any of them by dropping a reserved-name
 * React template in `emails/`:
 *
 *   emails/auth-confirm.tsx  -> email verification   (interpolates `{link}`)
 *   emails/auth-reset.tsx    -> password reset        (interpolates `{link}`)
 *   emails/auth-2fa.tsx      -> 2FA code              (interpolates `{code}`)
 *
 * Whenever auth is on, the build (re)writes an ambient `_auth_emails.ts` into the
 * toiljs `server/globals` LIB dir, exposing `AuthEmail.confirm/reset/twofa` baked
 * with the app's override when present and the default otherwise. Because it rides
 * the same `lib` set as `EmailService`/`AuthService`, the node_modules-compiled
 * `AuthController` calls it with NO import (an exported namespace in a plain app
 * entry would be module-scoped, not global). Every send goes through
 * `EmailTemplate.sendDetached`, so overriding a template can never reintroduce the
 * auth email-enumeration timing oracle the detached send closes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pc from 'picocolors';
import { createServer } from 'vite';

import type { ResolvedToilConfig } from './config.js';
import { RESERVED_AUTH_EMAIL_NAMES, renderEmailFile, toPascal, type RenderedEmail } from './emails.js';
import { createViteConfig } from './vite.js';

/**
 * The toiljs package's `server/globals` LIB directory: the ambient, no-import
 * surface (`EmailService`, `AuthService`, …) the toilconfig `lib` array points
 * at. The auth-email module is generated HERE, not in the app's `server/` dir,
 * because that is what makes `AuthEmail` resolvable from the node_modules-compiled
 * `AuthController` with NO import (an exported namespace in a plain app entry is
 * module-scoped, not global). Prefers the app's install so a symlinked/linked
 * toiljs is followed; falls back to the running package (hoisted install).
 */
function globalsDir(root: string): string {
    const inApp = path.join(root, 'node_modules', 'toiljs', 'server', 'globals');
    if (fs.existsSync(inApp)) return inApp;
    const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    return path.join(pkgDir, 'server', 'globals');
}

/** The reserved override names (PascalCase), one per built-in auth email. */
type AuthName = 'AuthConfirm' | 'AuthReset' | 'Auth2fa';

/** One built-in auth email: its reserved override name, the token it fills, the
 *  host-side `purpose` tag, and the default subject/text/html (with `{{token}}`). */
interface AuthEmailSpec {
    /** The generated `AuthEmail.<fn>` this feeds. */
    readonly fn: 'confirm' | 'reset' | 'twofa';
    /** The single runtime value the template interpolates. */
    readonly token: 'link' | 'code';
    /** Host dedup/abuse tag; must match what AuthController passed before. */
    readonly purpose: string;
    /** Default subject. Empty (and ignored) for `twofa`: AuthController passes login/setup subjects. */
    readonly defaultSubject: string;
    readonly defaultText: string;
    readonly defaultHtml: string;
    /** Whether the subject is a runtime arg (twofa) rather than a baked default (confirm/reset). */
    readonly subjectFromArg: boolean;
}

/** The reserved override name -> its spec. Keys mirror {@link RESERVED_AUTH_EMAIL_NAMES}. */
const SPECS: Record<AuthName, AuthEmailSpec> = {
    AuthConfirm: {
        fn: 'confirm',
        token: 'link',
        purpose: 'verify',
        subjectFromArg: false,
        defaultSubject: 'Confirm your account',
        defaultText: 'Confirm your account by opening this link:\n{{link}}\n',
        defaultHtml:
            '<p>Confirm your account by clicking the link below:</p>' +
            '<p><a href="{{link}}">Confirm my account</a></p>' +
            '<p>Or paste this into your browser:<br>{{link}}</p>',
    },
    AuthReset: {
        fn: 'reset',
        token: 'link',
        purpose: 'reset',
        subjectFromArg: false,
        defaultSubject: 'Reset your password',
        defaultText: 'Reset your password by opening this link:\n{{link}}\n',
        defaultHtml:
            '<p>We received a request to reset your password. Click the link below:</p>' +
            '<p><a href="{{link}}">Reset my password</a></p>' +
            '<p>If you did not request this, you can ignore this email.</p>' +
            '<p>Or paste this into your browser:<br>{{link}}</p>',
    },
    Auth2fa: {
        fn: 'twofa',
        token: 'code',
        purpose: '2fa',
        subjectFromArg: true,
        // Subject is supplied by AuthController (login vs setup), so it is not baked.
        defaultSubject: '',
        defaultText:
            'Your verification code is {{code}}.\n' +
            'It expires in a few minutes. If you did not request it, ignore this email.\n',
        defaultHtml:
            '<p>Your verification code is:</p>' +
            '<p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{code}}</p>' +
            '<p>It expires in a few minutes. If you did not request it, ignore this email.</p>',
    },
};

const AUTH_NAMES = Object.keys(SPECS) as AuthName[];

/** The effective (override-or-default) parts for each auth email. */
type Parts = Record<AuthName, Effective>;
interface Effective {
    readonly subject: string;
    readonly text: string;
    readonly html: string;
}

const GENERATED_BASENAME = '_auth_emails.ts';

function warn(msg: string): void {
    process.stderr.write(`  toil: auth emails ${msg}\n`);
}

/** A valid AS/JS string literal (double-quoted, fully escaped). */
function asLit(s: string): string {
    return JSON.stringify(s);
}

/** Every reserved auth-override file present in `emails/`, by PascalCase name. */
function reservedFilesIn(emailsDir: string): Map<AuthName, string> {
    const out = new Map<AuthName, string>();
    if (!fs.existsSync(emailsDir)) return out;
    for (const f of fs.readdirSync(emailsDir).sort()) {
        if (!/\.(tsx|jsx)$/.test(f)) continue;
        const name = toPascal(f.replace(/\.(tsx|jsx)$/, ''));
        if (RESERVED_AUTH_EMAIL_NAMES.has(name) && !out.has(name as AuthName))
            out.set(name as AuthName, f);
    }
    return out;
}

/**
 * Fold a rendered override into the effective parts for `name`, warning about
 * templates that will not interpolate correctly (a missing required token means
 * the link/code would be absent; an extra token renders empty). A `subject` the
 * renderer defaulted to the module name is treated as "no custom subject".
 */
function effectiveFromOverride(name: AuthName, spec: AuthEmailSpec, r: RenderedEmail): Effective {
    if (!r.tokens.includes(spec.token))
        warn(
            `override emails/${name} never uses the {${spec.token}} prop, so the ` +
                `${spec.token === 'link' ? 'link' : 'code'} will be missing from the email.`,
        );
    for (const t of r.tokens)
        if (t !== spec.token)
            warn(
                `override emails/${name} uses {${t}}, which auth does not provide ` +
                    `(only {${spec.token}}); it will render empty.`,
            );
    // For twofa the subject is a runtime arg; for confirm/reset use the template's
    // subject unless it defaulted to the component name (no `export const subject`).
    const subject = spec.subjectFromArg || r.subject === name ? spec.defaultSubject : r.subject;
    return { subject, text: r.text, html: r.html };
}

/** Codegen one `AuthEmail.<fn>` function. `twofa` takes its subject as an arg. */
function emitFn(spec: AuthEmailSpec, eff: Effective): string[] {
    const subjectExpr = spec.subjectFromArg ? 'subject' : asLit(eff.subject);
    const sig =
        spec.fn === 'twofa'
            ? 'twofa(to: string, code: string, subject: string): void'
            : `${spec.fn}(to: string, ${spec.token}: string): void`;
    return [
        `  export function ${sig} {`,
        `    const T: string = ${asLit(eff.text)};`,
        `    const H: string = ${asLit(eff.html)};`,
        `    const v = new Map<string, string>();`,
        `    v.set(${asLit(spec.token)}, ${spec.token});`,
        `    new EmailTemplate(${subjectExpr}, T, H).sendDetached(to, v, ${asLit(spec.purpose)});`,
        `  }`,
    ];
}

/** Codegen the ambient `AuthEmail` AssemblyScript module. */
function moduleSource(parts: Parts): string {
    const out: string[] = [
        '// GENERATED by toiljs from the built-in auth email templates -- DO NOT EDIT.',
        '// Override any of these by adding emails/auth-confirm.tsx, emails/auth-reset.tsx,',
        '// or emails/auth-2fa.tsx (see docs/auth/emails.md). `EmailTemplate` is a toiljs',
        '// global (server/globals/email.ts); the detached send keeps auth constant-time.',
        '',
        'export namespace AuthEmail {',
    ];
    for (const name of AUTH_NAMES) out.push(...emitFn(SPECS[name], parts[name]));
    out.push('}');
    return out.join('\n') + '\n';
}

/**
 * (Re)write `_auth_emails.ts` in the toiljs lib globals dir so the built-in auth
 * controller has its email senders, baking any reserved `emails/*.tsx` override
 * over the default. Runs BEFORE the toilscript server build (like
 * {@link renderEmails}) so the module is compiled in. A no-op that removes a stale
 * module when `authOn` is false. Only spins up Vite when an override actually
 * exists.
 */
export async function renderAuthEmails(cfg: ResolvedToilConfig, authOn: boolean): Promise<void> {
    const generatedPath = path.join(globalsDir(cfg.root), GENERATED_BASENAME);

    if (!authOn) {
        if (fs.existsSync(generatedPath)) fs.rmSync(generatedPath);
        return;
    }

    const emailsDir = path.join(cfg.root, 'emails');
    const overrides = reservedFilesIn(emailsDir);

    // Start from every default, then render + fold in whatever the app overrides.
    const parts = {} as Parts;
    for (const name of AUTH_NAMES) {
        const spec = SPECS[name];
        parts[name] = { subject: spec.defaultSubject, text: spec.defaultText, html: spec.defaultHtml };
    }

    if (overrides.size > 0) {
        const { renderToStaticMarkup } = await import('react-dom/server');
        const server = await createServer({
            ...(await createViteConfig(cfg)),
            server: { middlewareMode: true, hmr: false },
            appType: 'custom',
            logLevel: 'silent',
        });
        try {
            for (const [name, file] of overrides) {
                try {
                    const r = await renderEmailFile(
                        server,
                        emailsDir,
                        file,
                        renderToStaticMarkup as (el: unknown) => string,
                    );
                    if (r) parts[name] = effectiveFromOverride(name, SPECS[name], r);
                    else warn(`skipped ${file} (no default-exported component)`);
                } catch (err) {
                    warn(`skipped ${file} (${err instanceof Error ? err.message : String(err)})`);
                }
            }
        } finally {
            await server.close();
        }
    }

    const next = moduleSource(parts);
    const prev = fs.existsSync(generatedPath) ? fs.readFileSync(generatedPath, 'utf8') : null;
    if (prev === next) return; // no change: do not bump mtime (would retrigger the dev watcher)
    fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
    fs.writeFileSync(generatedPath, next);
    if (overrides.size > 0)
        process.stdout.write(
            pc.green('  ✓ ') +
                pc.dim(
                    `auth emails: overrode ${[...overrides.keys()].map((n) => SPECS[n].fn).join(', ')}`,
                ) +
                '\n',
        );
}

/** The generated module's basename, so the server watcher can ignore its own output. */
export const AUTH_EMAILS_GENERATED_BASENAME = GENERATED_BASENAME;

// Exported for unit testing the pure fold/codegen without a Vite server.
export const __test = { moduleSource, effectiveFromOverride, SPECS };

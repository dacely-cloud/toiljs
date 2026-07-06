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

import pc from 'picocolors';
import { createServer } from 'vite';

import type { ResolvedToilConfig } from './config.js';
import { RESERVED_AUTH_EMAIL_NAMES, renderEmailFile, toPascal, type RenderedEmail } from './emails.js';
import { createViteConfig } from './vite.js';

/**
 * The APP-LOCAL library directory the auth-email module is generated into,
 * relative to the project root (posix, for the toilscript `--lib` CLI arg). It is
 * passed to the compiler via `--lib` (see runToilscriptPass), which "uses exports
 * of all top-level files at this path as globals". That is what makes the
 * generated `AuthEmail` namespace resolvable from the node_modules-compiled
 * `AuthController` with NO import, the same way `EmailService`/`AuthService` are
 * ambient. Generating HERE (the app's own gitignored `.toil/`) rather than into
 * `node_modules/toiljs/server/globals` keeps it PER-APP: a pnpm/workspace/linked
 * install physically shares that package dir, so writing there would let one app
 * clobber another's templates (or delete the file another app is compiling), and
 * a read-only store would fail the build. `.toil` is always app-writable.
 */
export const AUTH_EMAILS_LIB_SUBDIR = '.toil/authlib';

/** The reserved override names (PascalCase), one per built-in auth email. */
type AuthName = 'AuthConfirm' | 'AuthReset' | 'Auth2fa';

/** One built-in auth email: its reserved override name, the token it fills, the
 *  host-side `purpose` tag, and the default subject/text/html (with `{{token}}`). */
interface AuthEmailSpec {
    /** The generated `AuthEmail.<fn>` this feeds. */
    readonly fn: 'confirm' | 'reset' | 'twofa';
    /** The token that MUST be present in an override (the link or code). */
    readonly requiredToken: 'link' | 'code';
    /** Every token the framework fills for this email (an override may use any subset). */
    readonly providedTokens: readonly string[];
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
        requiredToken: 'link',
        providedTokens: ['link'],
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
        requiredToken: 'link',
        providedTokens: ['link'],
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
        requiredToken: 'code',
        // `code` is the 6-digit code; `action` is the flow phrase AuthController passes
        // ("sign in" / "enable two-factor authentication" / "turn off two-factor
        // authentication"), so one 2FA template reads correctly for login vs setup.
        providedTokens: ['code', 'action'],
        purpose: '2fa',
        subjectFromArg: true,
        // Subject is supplied by AuthController (login vs setup), so it is not baked.
        defaultSubject: '',
        defaultText:
            'Your verification code is {{code}}.\n' +
            'Enter it to {{action}}. It expires in a few minutes. If you did not request it, ignore this email.\n',
        defaultHtml:
            '<p>Your verification code is:</p>' +
            '<p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{code}}</p>' +
            '<p>Enter it to {{action}}. It expires in a few minutes. If you did not request it, ignore this email.</p>',
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
    if (!r.tokens.includes(spec.requiredToken))
        warn(
            `override emails/${name} never uses the {${spec.requiredToken}} prop, so the ` +
                `${spec.requiredToken === 'link' ? 'link' : 'code'} will be missing from the email.`,
        );
    for (const t of r.tokens)
        if (!spec.providedTokens.includes(t))
            warn(
                `override emails/${name} uses {${t}}, which auth does not provide (only ` +
                    `${spec.providedTokens.map((x) => '{' + x + '}').join(', ')}); it will render empty.`,
            );
    // For twofa the subject is a runtime arg; for confirm/reset use the template's
    // subject unless it defaulted to the component name (no `export const subject`).
    const subject = spec.subjectFromArg || r.subject === name ? spec.defaultSubject : r.subject;
    return { subject, text: r.text, html: r.html };
}

/** Codegen one `AuthEmail.<fn>` function. `twofa` takes its subject as an arg. */
function emitFn(spec: AuthEmailSpec, eff: Effective): string[] {
    let sig: string;
    let subjectExpr: string;
    let sets: string[];
    if (spec.fn === 'twofa') {
        // twofa takes its subject AND its action phrase as runtime args (login vs setup).
        sig = 'twofa(to: string, code: string, subject: string, action: string): void';
        subjectExpr = 'subject';
        sets = ['v.set("code", code);', 'v.set("action", action);'];
    } else {
        sig = `${spec.fn}(to: string, ${spec.requiredToken}: string): void`;
        subjectExpr = asLit(eff.subject);
        sets = [`v.set(${asLit(spec.requiredToken)}, ${spec.requiredToken});`];
    }
    return [
        `  export function ${sig} {`,
        `    const T: string = ${asLit(eff.text)};`,
        `    const H: string = ${asLit(eff.html)};`,
        `    const v = new Map<string, string>();`,
        ...sets.map((s) => `    ${s}`),
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
 * Best-effort removal of a stale copy from the pre-0.0.107 location
 * (`node_modules/toiljs/server/globals/_auth_emails.ts`). Leaving it there would
 * define a SECOND `AuthEmail` namespace alongside the new app-local one and break
 * the compile with a duplicate symbol, so a project upgraded in place (without a
 * fresh `npm i`) is cleaned up here. Never throws (a read-only store just skips).
 */
function removeLegacyModule(root: string): void {
    try {
        const legacy = path.join(root, 'node_modules', 'toiljs', 'server', 'globals', GENERATED_BASENAME);
        if (fs.existsSync(legacy)) fs.rmSync(legacy);
    } catch {
        // read-only / missing: nothing to clean, not fatal
    }
}

/**
 * (Re)write `_auth_emails.ts` into the app-local `.toil/authlib` LIB dir so the
 * built-in auth controller has its email senders, baking any reserved
 * `emails/*.tsx` override over the default. Runs BEFORE the toilscript server
 * build (like {@link renderEmails}) so the module is compiled in via `--lib`. A
 * no-op that removes a stale module when auth is off or there is no server. Only
 * spins up Vite when an override actually exists.
 */
export async function renderAuthEmails(cfg: ResolvedToilConfig, authOn: boolean): Promise<void> {
    const generatedPath = path.join(cfg.root, AUTH_EMAILS_LIB_SUBDIR, GENERATED_BASENAME);
    removeLegacyModule(cfg.root);

    // No server to compile into, or auth off: ensure no stale module lingers.
    const hasServer = fs.existsSync(path.join(cfg.root, 'toilconfig.json'));
    if (!authOn || !hasServer) {
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

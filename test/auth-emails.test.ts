/**
 * The built-in auth email OVERRIDE codegen (src/compiler/auth-emails.ts): the
 * pure fold (a rendered emails/auth-*.tsx over the default) and the AssemblyScript
 * `AuthEmail` module it bakes. The Vite-render + file IO in `renderAuthEmails` is
 * covered by the example build; here we test the string transforms in isolation.
 */
import { describe, expect, it } from 'vitest';

import { __test } from '../src/compiler/auth-emails';
import type { RenderedEmail } from '../src/compiler/emails';

const { moduleSource, effectiveFromOverride, SPECS } = __test;

/** A defaults-only parts map (what a project with no overrides generates). */
function defaultParts(): Record<string, { subject: string; text: string; html: string }> {
    const parts: Record<string, { subject: string; text: string; html: string }> = {};
    for (const [name, spec] of Object.entries(SPECS))
        parts[name] = {
            subject: spec.defaultSubject,
            text: spec.defaultText,
            html: spec.defaultHtml,
        };
    return parts;
}

function rendered(name: string, over: Partial<RenderedEmail>): RenderedEmail {
    return {
        name,
        subject: over.subject ?? name,
        html: over.html ?? '',
        text: over.text ?? '',
        tokens: over.tokens ?? [],
        purpose: over.purpose ?? name.toLowerCase(),
    };
}

describe('AuthEmail module codegen', () => {
    it('emits confirm/reset/twofa, each through the DETACHED send with its purpose', () => {
        const src = moduleSource(defaultParts());
        expect(src).toContain('export namespace AuthEmail {');
        expect(src).toContain('export function confirm(to: string, link: string): void');
        expect(src).toContain('export function reset(to: string, link: string): void');
        // twofa takes the subject as a runtime arg (login vs setup), not baked.
        expect(src).toContain(
            'export function twofa(to: string, code: string, subject: string, action: string): void',
        );
        // Every send is detached (the anti-enumeration property), never the suspending send.
        expect(src.match(/\.sendDetached\(/g)).toHaveLength(3);
        expect(src).not.toContain('.send(to');
        expect(src).toContain('"verify"');
        expect(src).toContain('"reset"');
        expect(src).toContain('"2fa"');
    });

    it('bakes the default subject for confirm/reset but passes `subject` through for twofa', () => {
        const src = moduleSource(defaultParts());
        expect(src).toContain('new EmailTemplate("Confirm your account"');
        expect(src).toContain('new EmailTemplate("Reset your password"');
        expect(src).toContain('new EmailTemplate(subject,'); // twofa uses the arg
    });

    it('interpolates the right token per email (link for confirm/reset, code + action for twofa)', () => {
        const src = moduleSource(defaultParts());
        expect(src).toContain('v.set("link", link)');
        expect(src).toContain('v.set("code", code)');
        expect(src).toContain('v.set("action", action)');
    });

    it('escapes baked HTML into a valid string literal', () => {
        const parts = defaultParts();
        parts.AuthConfirm = {
            subject: 'Hi "there"',
            text: 'a\nb',
            html: '<a href="x">c</a>',
        };
        const src = moduleSource(parts);
        // JSON.stringify escaping keeps the emitted AS parseable (quotes/newlines escaped).
        expect(src).toContain('"Hi \\"there\\""');
        expect(src).toContain('"<a href=\\"x\\">c</a>"');
    });
});

describe('effectiveFromOverride', () => {
    it('uses the override subject/text/html when the template sets a subject', () => {
        const eff = effectiveFromOverride(
            'AuthConfirm',
            SPECS.AuthConfirm,
            rendered('AuthConfirm', {
                subject: 'Verify your Acme account',
                html: '<p>{{link}}</p>',
                text: '{{link}}',
                tokens: ['link'],
            }),
        );
        expect(eff.subject).toBe('Verify your Acme account');
        expect(eff.html).toBe('<p>{{link}}</p>');
    });

    it('falls back to the default subject when the template did not set one', () => {
        // renderModule defaults `subject` to the module name when no `export const subject`.
        const eff = effectiveFromOverride(
            'AuthConfirm',
            SPECS.AuthConfirm,
            rendered('AuthConfirm', { subject: 'AuthConfirm', html: '<p>{{link}}</p>', tokens: ['link'] }),
        );
        expect(eff.subject).toBe('Confirm your account');
    });

    it('ignores an override subject for twofa (login/setup subject is contextual)', () => {
        const eff = effectiveFromOverride(
            'Auth2fa',
            SPECS.Auth2fa,
            rendered('Auth2fa', { subject: 'ignored', html: '<b>{{code}}</b>', tokens: ['code'] }),
        );
        expect(eff.subject).toBe(''); // subjectFromArg: baked subject stays empty (the arg wins at runtime)
        expect(eff.html).toBe('<b>{{code}}</b>');
    });
});

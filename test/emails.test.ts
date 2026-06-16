import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { __test } from '../src/compiler/emails';

const render = (el: unknown): string => renderToStaticMarkup(el as ReactElement);

describe('renderModule', () => {
    it('discovers props as {{tokens}} and renders placeholders (alpha-sorted, deduped)', async () => {
        const mod = {
            default: (p: { name: string; code: string }) =>
                createElement('p', null, `Hi ${p.name}, code ${p.code}`),
        };
        const r = await __test.renderModule('Welcome', mod, render);
        if (!r) throw new Error('expected a rendered email');
        expect(r.tokens).toEqual(['code', 'name']);
        expect(r.html).toContain('{{name}}');
        expect(r.html).toContain('{{code}}');
    });

    it('returns null when there is no default-exported component', async () => {
        expect(await __test.renderModule('X', { default: 'nope' }, render)).toBeNull();
    });

    it('inlines imported CSS into element style="" (the reuse path)', async () => {
        const mod = { default: () => createElement('h1', { className: 'email-title' }, 'Hello') };
        const css = '.email-title { color: #111827; font-size: 22px; }';
        const r = await __test.renderModule('Styled', mod, render, css);
        if (!r) throw new Error('expected a rendered email');
        // The class rule is moved onto the element as an inline style by the inliner.
        expect(r.html).toMatch(/<h1[^>]*style="[^"]*color:\s*#111827/i);
        expect(r.html).toMatch(/font-size:\s*22px/i);
    });
});

describe('renderModuleSource', () => {
    it('generates a typed Emails.<Name>.send with alpha-sorted token params', () => {
        const src = __test.renderModuleSource([
            {
                name: 'Welcome',
                subject: 'Welcome, {{name}}!',
                html: '<p>{{code}}</p>',
                text: 'code {{code}}',
                tokens: ['code', 'name'],
                purpose: 'welcome',
            },
        ]);
        expect(src).toContain('export namespace Emails {');
        expect(src).toContain('export namespace Welcome {');
        expect(src).toContain(
            'export function send(to: string, code: string, name: string, purpose: string = "welcome")',
        );
        expect(src).toContain(
            'return new EmailTemplate(SUBJECT, TEXT, HTML).send(to, __v, purpose);',
        );
    });
});

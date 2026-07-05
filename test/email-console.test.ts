/**
 * Dev email emulator (src/devserver/email/console.ts): the ASCII-drawn box + the
 * HTML->text conversion + action (link/code) extraction that make confirm/reset/2FA
 * flows testable in `toiljs dev` without a real inbox.
 */
import { describe, expect, it } from 'vitest';

import { emailAction, htmlToText, renderEmailConsole } from '../src/devserver/email/console.js';

const confirmEmail = {
    to: 'bob@gmail.com',
    subject: 'Confirm your account',
    purpose: 'verify',
    body: 'Confirm your account by opening this link:\nhttp://localhost:3000/confirm#token=abc123\n',
    html:
        '<p>Confirm your account by clicking the link below:</p>' +
        '<p><a href="http://localhost:3000/confirm#token=abc123">Confirm my account</a></p>',
};

/** picocolors may or may not emit ANSI depending on TTY; strip it for assertions. */
const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

describe('dev email emulator', () => {
    it('htmlToText: anchors become "text (url)", blocks become newlines, entities decode', () => {
        const t = htmlToText('<p>Hi &amp; welcome</p><p><a href="https://x.com/a?b=1">Open</a></p>');
        expect(t).toContain('Hi & welcome');
        expect(t).toContain('Open (https://x.com/a?b=1)');
    });

    it('emailAction extracts the link from a confirm email', () => {
        expect(emailAction(confirmEmail)).toEqual({
            kind: 'link',
            value: 'http://localhost:3000/confirm#token=abc123',
        });
    });

    it('emailAction extracts a 2FA code when there is no link', () => {
        const twofa = { to: 'x', subject: 's', purpose: '2fa', body: 'Your code is 481920.', html: '' };
        expect(emailAction(twofa)).toEqual({ kind: 'code', value: '481920' });
    });

    it('emailAction falls back to the HTML body when the text body is empty', () => {
        expect(emailAction({ ...confirmEmail, body: '' })?.value).toBe(
            'http://localhost:3000/confirm#token=abc123',
        );
    });

    it('renderEmailConsole draws a box with recipient, subject, and the clickable link', () => {
        const box = plain(renderEmailConsole(confirmEmail, 'not sent'));
        expect(box).toContain('bob@gmail.com');
        expect(box).toContain('Confirm your account');
        expect(box).toContain('http://localhost:3000/confirm#token=abc123');
        expect(box).toContain('┌');
        expect(box).toContain('└');
    });
});

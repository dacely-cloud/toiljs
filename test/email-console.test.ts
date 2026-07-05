/**
 * Dev email emulator (src/devserver/email/console.ts): the ASCII-drawn box + the
 * HTML->text conversion + action (link/code) extraction that make confirm/reset/2FA
 * flows testable in `toiljs dev` without a real inbox.
 */
import { describe, expect, it } from 'vitest';

import {
    emailAction,
    htmlToText,
    parseColor,
    renderEmailConsole,
    renderHtmlBody,
} from '../src/devserver/email/console.js';

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

    it('parseColor: hex, short hex, rgb, and named colors', () => {
        expect(parseColor('#ff0000')).toEqual([255, 0, 0]);
        expect(parseColor('#0f0')).toEqual([0, 255, 0]);
        expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30]);
        expect(parseColor('red')).toEqual([229, 57, 53]);
        expect(parseColor('not-a-color')).toBeUndefined();
    });

    it('renderHtmlBody: keeps text + link, splits paragraphs, wraps to width', () => {
        const lines = renderHtmlBody(
            '<p>Hi <b>there</b> &amp; welcome</p>' +
                '<p><a href="https://x.com/a?b=1">Open</a></p>',
            40,
        );
        const joined = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
        expect(joined).toContain('Hi there & welcome');
        expect(joined).toContain('Open');
        expect(joined).toContain('(https://x.com/a?b=1)');
        // a blank separator line sits between the two paragraphs
        expect(lines).toContain('');
        // no line exceeds the wrap width (visible chars; color is off under vitest)
        for (const l of lines) expect(l.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(40);
    });
});

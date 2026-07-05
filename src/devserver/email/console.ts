/**
 * DEV EMAIL EMULATOR: renders an outgoing email as an ASCII-drawn box in the
 * terminal so confirm / reset / 2FA flows are testable locally WITHOUT a real
 * inbox (the whole point of dev). It converts the HTML body to readable text,
 * lays it out under a left-barred box, and highlights the ACTION (the one-time
 * link, which carries its token in the `#token=` fragment and so is directly
 * clickable, or the numeric 2FA code). Dev-only; the production edge never renders
 * or logs token material.
 *
 * The box uses a LEFT bar plus full top/bottom rules (no right border), so colored
 * spans never break column alignment and long URLs stay on one unbroken, clickable
 * line.
 */
import pc from 'picocolors';

import { type ParsedEmail } from './wire.js';

const WIDTH = 68; // wrap column for body text (URLs are left un-wrapped)

/** Decode the handful of HTML entities our built-in templates can emit. */
function decodeEntities(s: string): string {
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)));
}

/**
 * A plain-text rendering of an HTML email body: anchors become `text (url)` so
 * the URL stays visible + clickable, block elements become line breaks, remaining
 * tags are stripped, entities decoded, and whitespace collapsed.
 */
export function htmlToText(html: string): string {
    let s = html;
    // <a href="URL">TEXT</a> -> "TEXT (URL)" (or just URL when text == url / empty)
    s = s.replace(
        /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_m, href: string, inner: string) => {
            const t = inner.replace(/<[^>]+>/g, '').trim();
            return t.length > 0 && t !== href ? `${t} (${href})` : href;
        },
    );
    // block-level tags -> newlines (open OR close), <br> -> newline
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/?(?:p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|header|footer)\b[^>]*>/gi, '\n');
    // strip whatever tags remain
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    // collapse intra-line whitespace, trim each line, cap blank runs at one
    s = s.replace(/[ \t]+/g, ' ');
    s = s
        .split('\n')
        .map((l) => l.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return s;
}

/** The actionable bit of an email: the first link, else a 4-8 digit code, else null. */
export function emailAction(parsed: ParsedEmail): { kind: 'link' | 'code'; value: string } | null {
    const body = parsed.body.length > 0 ? parsed.body : htmlToText(parsed.html);
    const link = /https?:\/\/[^\s"'<>)]+/.exec(body);
    if (link !== null) return { kind: 'link', value: link[0] };
    const code = /\b(\d{4,8})\b/.exec(body);
    if (code !== null) return { kind: 'code', value: code[1] };
    return null;
}

/** Word-wrap to `width`; words longer than `width` (URLs, tokens) overflow rather
 *  than being hard-split, so they stay intact and clickable. */
function wrap(text: string, width: number): string[] {
    const out: string[] = [];
    for (const para of text.split('\n')) {
        if (para.length === 0) {
            out.push('');
            continue;
        }
        let line = '';
        for (const word of para.split(' ')) {
            if (line.length === 0) line = word;
            else if (line.length + 1 + word.length <= width) line += ' ' + word;
            else {
                out.push(line);
                line = word;
            }
        }
        out.push(line);
    }
    return out;
}

/**
 * The full ASCII box for one dev email. `status` is a short label for the header
 * (e.g. `not sent - no provider`, `sent`, `deduped`).
 */
export function renderEmailConsole(parsed: ParsedEmail, status: string): string {
    const bar = pc.dim('  │ ');
    const rule = (label: string): string => {
        const head = label.length > 0 ? `─ ${label} ` : '─';
        const fill = '─'.repeat(Math.max(0, WIDTH + 2 - head.length));
        return pc.dim(`  ├${head}${fill}`);
    };
    const purpose = parsed.purpose.length > 0 ? ` · ${parsed.purpose}` : '';
    const header = `─ ✉  ${pc.bold('Email')} ${pc.dim(`(dev${purpose} · ${status})`)} `;
    const topFill = '─'.repeat(Math.max(0, WIDTH + 2 - `─ ✉  Email (dev${purpose} · ${status}) `.length));

    const lines: string[] = [];
    lines.push(pc.dim(`  ┌${header}${topFill}`));
    lines.push(bar + pc.dim('To:      ') + parsed.to);
    lines.push(bar + pc.dim('Subject: ') + parsed.subject);
    lines.push(pc.dim('  │'));

    const bodyText = parsed.body.length > 0 ? parsed.body : htmlToText(parsed.html);
    for (const l of wrap(bodyText, WIDTH)) lines.push(l.length === 0 ? pc.dim('  │') : bar + l);

    const action = emailAction(parsed);
    if (action !== null) {
        if (action.kind === 'link') {
            lines.push(rule('🔗 click to continue'));
            lines.push(bar + pc.cyan(pc.underline(action.value)));
        } else {
            lines.push(rule('🔢 code'));
            lines.push(bar + pc.bold(pc.yellow(action.value)));
        }
    }
    lines.push(pc.dim(`  └${'─'.repeat(WIDTH + 2)}`));
    return lines.join('\n');
}

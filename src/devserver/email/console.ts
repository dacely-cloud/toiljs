/**
 * DEV EMAIL EMULATOR: renders an outgoing email as an ASCII-drawn box in the
 * terminal so confirm / reset / 2FA flows are testable locally WITHOUT a real
 * inbox (the whole point of dev). It converts the HTML body to readable text WITH
 * terminal color + font styling (bold / italic / underline / colored text taken
 * from the HTML), lays it out under a left-barred box, and highlights the ACTION
 * (the one-time link, which carries its token in the `#token=` fragment and so is
 * directly clickable, or the numeric 2FA code). Dev-only; the production edge never
 * renders or logs token material.
 *
 * The box uses a LEFT bar plus full top/bottom rules (no right border), so colored
 * spans never break column alignment and long URLs stay on one unbroken, clickable
 * line. Styling is emitted only when the terminal supports color (a piped/CI run
 * gets clean plain text).
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
 * A plain-text (no color) rendering of an HTML email body: anchors become
 * `text (url)`, block elements become line breaks, remaining tags are stripped,
 * entities decoded, whitespace collapsed. Kept for the action-extraction fallback
 * and any caller that wants text without escape codes.
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
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/?(?:p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|header|footer)\b[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
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

// --- HTML -> STYLED terminal spans -----------------------------------------------------------------

type Rgb = readonly [number, number, number];
interface Style {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    color?: Rgb;
}
interface Word {
    readonly text: string;
    readonly style: Style;
    /** Whether whitespace separated this word from the previous one in the source
     *  (so `<b>bob</b>,` renders as `bob,` not `bob ,`). */
    readonly spaceBefore: boolean;
}

/** A small palette of CSS color names our templates (and most emails) use. */
const NAMED: Record<string, Rgb> = {
    black: [0, 0, 0], white: [235, 235, 235], red: [229, 57, 53], green: [67, 160, 71],
    blue: [30, 136, 229], yellow: [253, 216, 53], orange: [251, 140, 0], purple: [142, 36, 170],
    magenta: [216, 27, 96], pink: [233, 30, 99], cyan: [0, 172, 193], teal: [0, 137, 123],
    indigo: [57, 73, 171], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
    gold: [255, 193, 7], brown: [121, 85, 72], navy: [26, 35, 126], lime: [124, 179, 66],
};

/** Parse a CSS color value (`#rgb`, `#rrggbb`, `rgb(...)`, or a named color) to RGB. */
export function parseColor(value: string): Rgb | undefined {
    const s = value.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (hex !== null) {
        const h = hex[1];
        if (h.length === 3) {
            return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
        }
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(s);
    if (rgb !== null) {
        return [Math.min(255, +rgb[1]), Math.min(255, +rgb[2]), Math.min(255, +rgb[3])];
    }
    return NAMED[s];
}

/** The style delta a tag (name + raw attributes) contributes. */
function styleFromTag(name: string, attrs: string): Style {
    const d: Style = {};
    if (name === 'b' || name === 'strong' || /^h[1-6]$/.test(name)) d.bold = true;
    if (name === 'i' || name === 'em') d.italic = true;
    if (name === 'u' || name === 'ins') d.underline = true;
    if (name === 'a') {
        d.underline = true;
        d.color = NAMED.cyan; // links stand out
    }
    if (name === 'code' || name === 'kbd' || name === 'pre' || name === 'samp') d.color = NAMED.gray;
    const styleAttr = /style\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (styleAttr !== null) {
        const css = styleAttr[1].toLowerCase();
        const colorM = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(css);
        if (colorM !== null) {
            const c = parseColor(colorM[1]);
            if (c !== undefined) d.color = c;
        }
        if (/font-weight\s*:\s*(?:bold|bolder|[6-9]00)/.test(css)) d.bold = true;
        if (/font-style\s*:\s*italic/.test(css)) d.italic = true;
        if (/text-decoration[^;]*:\s*[^;]*underline/.test(css)) d.underline = true;
    }
    if (name === 'font') {
        const fc = /\bcolor\s*=\s*["']([^"']+)["']/i.exec(attrs);
        if (fc !== null) {
            const c = parseColor(fc[1]);
            if (c !== undefined) d.color = c;
        }
    }
    return d;
}

/** Flatten a style stack (last color / any true flag wins). */
function compose(stack: readonly Style[]): Style {
    const out: Style = {};
    for (const s of stack) {
        if (s.bold) out.bold = true;
        if (s.italic) out.italic = true;
        if (s.underline) out.underline = true;
        if (s.color !== undefined) out.color = s.color;
    }
    return out;
}

const BLOCK = new Set([
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'table', 'ul', 'ol',
    'blockquote', 'section', 'header', 'footer', 'br', 'hr', 'article', 'main', 'nav', 'aside',
]);

/** Parse an HTML body into paragraphs (split on block elements) of styled words,
 *  preserving whether each word was space-separated from the previous one. */
function htmlToParagraphs(html: string): Word[][] {
    const paras: Word[][] = [];
    let cur: Word[] = [];
    let pendingSpace = false; // a space boundary carried across tag boundaries
    const flush = (): void => {
        if (cur.length > 0) {
            paras.push(cur);
            cur = [];
        }
        pendingSpace = false;
    };
    const stack: Style[] = [];
    const hrefs: (string | null)[] = [];
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const raw = m[4];
        if (raw !== undefined) {
            const norm = decodeEntities(raw).replace(/\s+/g, ' ').trim();
            if (norm.length === 0) {
                if (/\s/.test(raw)) pendingSpace = true;
                continue;
            }
            const leading = /^\s/.test(raw) || pendingSpace;
            const st = compose(stack);
            const words = norm.split(' ');
            for (let i = 0; i < words.length; i++) {
                cur.push({ text: words[i], style: st, spaceBefore: cur.length > 0 && (i > 0 || leading) });
            }
            pendingSpace = /\s$/.test(raw);
            continue;
        }
        const closing = m[1] === '/';
        const name = m[2].toLowerCase();
        const attrs = m[3] ?? '';
        if (BLOCK.has(name)) {
            flush();
            if (/^h[1-6]$/.test(name)) {
                if (closing) stack.pop();
                else stack.push(styleFromTag(name, attrs));
            }
            continue;
        }
        if (closing) {
            stack.pop();
            if (name === 'a') {
                const href = hrefs.pop();
                if (href) {
                    cur.push({
                        text: `(${href})`,
                        style: { ...compose(stack), color: NAMED.gray },
                        spaceBefore: cur.length > 0,
                    });
                }
            }
        } else {
            stack.push(styleFromTag(name, attrs));
            if (name === 'a') {
                const hm = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs);
                hrefs.push(hm !== null ? hm[1] : null);
            }
        }
    }
    flush();
    return paras;
}

/** Apply a style to a string as terminal escapes (no-op when color is unsupported). */
function paint(style: Style, s: string): string {
    if (!pc.isColorSupported) return s;
    let open = '';
    if (style.bold) open += '\x1b[1m';
    if (style.italic) open += '\x1b[3m';
    if (style.underline) open += '\x1b[4m';
    if (style.color !== undefined) open += `\x1b[38;2;${style.color[0]};${style.color[1]};${style.color[2]}m`;
    return open === '' ? s : `${open}${s}\x1b[0m`;
}

/** Word-wrap styled words to `width` VISIBLE columns; over-long words (URLs) overflow.
 *  Honors each word's `spaceBefore` so attached punctuation is not pushed off. */
function wrapWords(words: readonly Word[], width: number): Word[][] {
    const lines: Word[][] = [];
    let line: Word[] = [];
    let len = 0;
    for (const w of words) {
        const sep = line.length > 0 && w.spaceBefore ? 1 : 0;
        if (line.length > 0 && len + sep + w.text.length > width) {
            lines.push(line);
            line = [w];
            len = w.text.length;
        } else {
            line.push(w);
            len += sep + w.text.length;
        }
    }
    if (line.length > 0) lines.push(line);
    return lines;
}

/**
 * Render an HTML body to styled terminal lines (visible width <= `width`). Empty
 * strings mark blank separator lines between paragraphs. Exported for tests.
 */
export function renderHtmlBody(html: string, width: number = WIDTH): string[] {
    const paras = htmlToParagraphs(html);
    const out: string[] = [];
    for (let p = 0; p < paras.length; p++) {
        if (p > 0) out.push(''); // one blank line between paragraphs
        for (const line of wrapWords(paras[p], width)) {
            out.push(
                line.map((w, i) => (i > 0 && w.spaceBefore ? ' ' : '') + paint(w.style, w.text)).join(''),
            );
        }
    }
    return out;
}

/** Word-wrap PLAIN text (the fallback when there is no HTML body). */
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
 * (e.g. `not sent, no provider`, `sent`, `deduped`). The body is rendered from the
 * HTML with color + font styling when present, else from the plain-text body.
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

    const bodyLines =
        parsed.html.length > 0 ? renderHtmlBody(parsed.html, WIDTH) : wrap(parsed.body, WIDTH);
    for (const l of bodyLines) lines.push(l.length === 0 ? pc.dim('  │') : bar + l);

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

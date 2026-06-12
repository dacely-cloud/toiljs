/**
 * Shared CLI presentation: the toiljs brand banner, gradient text, and small helpers.
 * Kept dependency-light (only picocolors); the gradient is hand-rolled truecolor ANSI so
 * the logo pops without pulling in a gradient library.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pc from 'picocolors';

type RGB = readonly [number, number, number];

/** toiljs brand palette. */
const PRIMARY: RGB = [37, 99, 255];
const SECONDARY: RGB = [124, 58, 237];
const ACCENT: RGB = [34, 227, 171];

/** Logo gradient stops: blue → purple → teal. */
const GRADIENT: readonly RGB[] = [PRIMARY, SECONDARY, ACCENT];

/** ANSI-shadow "TOIL" wordmark. */
const ART: readonly string[] = [
    '████████╗  ██████╗  ██╗ ██╗     ',
    '╚══██╔══╝ ██╔═══██╗ ██║ ██║     ',
    '   ██║    ██║   ██║ ██║ ██║     ',
    '   ██║    ██║   ██║ ██║ ██║     ',
    '   ██║    ╚██████╔╝ ██║ ███████╗',
    '   ╚═╝     ╚═════╝  ╚═╝ ╚══════╝',
];

export const dim = pc.dim;
export const bold = pc.bold;

/** True when we should emit ANSI color: a TTY (or FORCE_COLOR), and not disabled via NO_COLOR. */
function colorEnabled(): boolean {
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return true;
    return process.stdout.isTTY;
}

function rgb(color: RGB, s: string): string {
    return colorEnabled() ? `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${s}\x1b[39m` : s;
}

/** The primary brand accent (blue). No-ops to plain text when color is disabled. */
export function brand(s: string): string {
    return rgb(PRIMARY, s);
}
export const accent = brand;

/** Success/positive accent (teal). */
export function success(s: string): string {
    return rgb(ACCENT, s);
}

/** Error accent (red, kept outside the brand palette since errors should read as errors). */
export const danger = pc.red;

/** Warning accent (yellow, outside the brand palette so warnings read as warnings). */
export const warn = pc.yellow;

function lerp(a: number, b: number, t: number): number {
    return Math.round(a + (b - a) * t);
}

/** Samples the multi-stop brand gradient at `t` in [0, 1]. */
function gradientAt(t: number): RGB {
    const segments = GRADIENT.length - 1;
    const scaled = t * segments;
    const i = Math.min(Math.floor(scaled), segments - 1);
    const a = GRADIENT[i];
    const b = GRADIENT[i + 1];
    const localT = scaled - i;
    return [lerp(a[0], b[0], localT), lerp(a[1], b[1], localT), lerp(a[2], b[2], localT)];
}

/** Colors each character of `line` along the left→right brand gradient. */
function gradientLine(line: string): string {
    const n = line.length;
    let out = '';
    for (let i = 0; i < n; i++) {
        const [r, g, b] = gradientAt(n > 1 ? i / (n - 1) : 0);
        out += `\x1b[38;2;${r};${g};${b}m${line[i]}`;
    }
    return out + '\x1b[39m';
}

/** Reads the toiljs package version (CLI lives at build/cli/, package root is two up). */
export function version(): string {
    try {
        const pkgPath = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '..',
            '..',
            'package.json',
        );
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const match = /"version"\s*:\s*"([^"]+)"/.exec(raw);
        if (match && match[1]) return match[1];
    } catch {}
    return '0.0.0';
}

// eslint-disable-next-line no-control-regex -- matching our own escape sequences is the point
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** The on-screen width of `s`, ignoring ANSI color codes. */
function visibleWidth(s: string): number {
    return s.replace(ANSI_RE, '').length;
}

/**
 * Frames already-colored lines in a rounded box sized to the widest line. `paint` colors the
 * border (the content keeps its own colors); padding is measured on the visible text, so ANSI
 * codes inside the lines never skew the right edge. Returns the box without a trailing newline.
 */
export function box(lines: readonly string[], paint: (s: string) => string = (s) => s): string {
    const width = lines.reduce((w, l) => Math.max(w, visibleWidth(l)), 0);
    const side = paint('│');
    const body = lines.map(
        (l) => `  ${side}  ${l}${' '.repeat(width - visibleWidth(l))}  ${side}`,
    );
    return [
        '  ' + paint(`╭${'─'.repeat(width + 4)}╮`),
        ...body,
        '  ' + paint(`╰${'─'.repeat(width + 4)}╯`),
    ].join('\n');
}

/** Prints the brand banner: gradient logo + tagline + version. */
export function banner(): void {
    const lines = colorEnabled() ? ART.map(gradientLine) : ART.slice();
    const tagline = `  the most performant ${brand('react')} framework`;
    const ver = `${dim('  v')}${brand(version())}`;
    process.stdout.write('\n' + lines.join('\n') + '\n\n' + tagline + '   ' + ver + '\n\n');
}

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

/** toiljs brand amber → deep gold. */
const FROM: RGB = [250, 204, 80];
const TO: RGB = [198, 112, 20];

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

/** True when we should emit ANSI color (a TTY, and not disabled via NO_COLOR). */
function colorEnabled(): boolean {
    return process.stdout.isTTY && !process.env.NO_COLOR;
}

/** The amber brand accent (truecolor). No-ops to plain text when color is disabled. */
export function brand(s: string): string {
    return colorEnabled() ? `\x1b[38;2;203;152;32m${s}\x1b[39m` : s;
}
export const accent = brand;

function lerp(a: number, b: number, t: number): number {
    return Math.round(a + (b - a) * t);
}

/** Colors each character of `line` along a left→right truecolor gradient. */
function gradientLine(line: string): string {
    const n = line.length;
    let out = '';
    for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0;
        const r = lerp(FROM[0], TO[0], t);
        const g = lerp(FROM[1], TO[1], t);
        const b = lerp(FROM[2], TO[2], t);
        out += `\x1b[38;2;${r};${g};${b}m${line[i]}`;
    }
    return out + '\x1b[39m';
}

/** Reads the toiljs package version (CLI lives at build/cli/, package root is two up). */
export function version(): string {
    try {
        const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const match = /"version"\s*:\s*"([^"]+)"/.exec(raw);
        if (match && match[1]) return match[1];
    } catch {
        /* fall through to default */
    }
    return '0.0.0';
}

/** Prints the brand banner: gradient logo + tagline + version. */
export function banner(): void {
    const lines = colorEnabled() ? ART.map(gradientLine) : ART.slice();
    const tagline = `  the full-stack ${brand('WebAssembly')} framework`;
    const ver = `${dim('  v')}${brand(version())}`;
    process.stdout.write('\n' + lines.join('\n') + '\n\n' + tagline + '   ' + ver + '\n\n');
}

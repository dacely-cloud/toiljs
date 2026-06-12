import { describe, expect, it } from 'vitest';

import { box, tagline } from '../src/cli/ui';

describe('tagline', () => {
    it('always yields a non-empty line, whichever variant is drawn', () => {
        for (let i = 0; i < 100; i++) {
            const t = tagline();
            expect(t.length).toBeGreaterThan(0);
            expect(t).not.toContain('undefined');
        }
    });
});

describe('box', () => {
    it('frames lines in a rounded box sized to the widest line', () => {
        expect(box(['hello', 'hi'])).toBe(
            [
                '  ╭─────────╮',
                '  │  hello  │',
                '  │  hi     │',
                '  ╰─────────╯',
            ].join('\n'),
        );
    });

    it('pads on visible width, ignoring ANSI color codes', () => {
        const colored = '\x1b[1mhello\x1b[22m';
        const lines = box([colored, 'hi']).split('\n');
        // Both content rows must end at the same column once colors are stripped.
        const stripped = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
        expect(new Set(stripped.map((l) => l.length)).size).toBe(1);
    });

    it('paints only the border', () => {
        const out = box(['hi'], (s) => `<${s}>`);
        expect(out).toContain('<│>  hi  <│>');
        expect(out).toContain('<╭──────╮>');
    });
});

import { describe, expect, it, vi } from 'vitest';
import { buildHostImports, freshDispatchState } from '../src/devserver/runtime/host.js';
import { buildDaemonImports, freshDaemonState } from '../src/devserver/daemon/host.js';
import { sanitizeServerLog } from '../src/devserver/runtime/logging.js';

const esc = '\u001b';
const reset = `${esc}[0m`;

const attacks = [
    [`${esc}]52;c;Y2xpcGJvYXJk\u0007`, '\\x1b]52;c;Y2xpcGJvYXJk\\x07'],
    [`${esc}]0;forged title${esc}\\`, '\\x1b]0;forged title\\x1b\\'],
    [
        `${esc}]8;;https://example.com\u0007link${esc}]8;;\u0007`,
        '\\x1b]8;;https://example.com\\x07link\\x1b]8;;\\x07',
    ],
    [`${esc}Pterminal command${esc}\\`, '\\x1bPterminal command\\x1b\\'],
    [`${esc}[2J${esc}[1;1H`, '\\x1b[2J\\x1b[1;1H'],
    ['guest\r\n[trusted] forged\b\t', 'guest\\x0d\\x0a[trusted] forged\\x08\\x09'],
    ['\u009b2J\u009d52;c;data\u009c', '\\x9b2J\\x9d52;c;data\\x9c'],
    [
        'a\u061c\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069z',
        'a\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a\\u202b\\u202c\\u202d\\u202e\\u2066\\u2067\\u2068\\u2069z',
    ],
    [`${esc}[31mred`, `${esc}[31mred${reset}`],
    [`${esc}[32mgreen${reset}`, `${esc}[32mgreen${reset}`],
] as const;

describe('terminal-safe guest messages', () => {
    it.each(attacks)('sanitizes terminal payload %j', (input, expected) => {
        expect(sanitizeServerLog(input)).toBe(expected);
    });

    it('escapes every C0/C1 control and DEL while preserving ordinary Unicode', () => {
        for (let code = 0; code <= 0x9f; code++) {
            if (code >= 0x20 && code < 0x7f) continue;
            expect(sanitizeServerLog(String.fromCharCode(code))).toBe(
                '\\x' + code.toString(16).padStart(2, '0'),
            );
        }
        expect(sanitizeServerLog('héllo 🌍 中文 %s ${doNotRun()}')).toBe(
            'héllo 🌍 中文 %s ${doNotRun()}',
        );
    });

    it('allows only bounded basic, 256-color and RGB color/reset sequences', () => {
        for (const code of [0, 30, 37, 39, 40, 47, 49, 90, 97, 100, 107]) {
            const color = `${esc}[${code}m`;
            expect(sanitizeServerLog(color + 'text')).toBe(color + 'text' + reset);
        }
        for (const params of ['38;5;0', '48;5;255', '38;2;0;128;255', '48;2;255;128;0']) {
            const color = `${esc}[${params}m`;
            expect(sanitizeServerLog(color + 'text')).toBe(color + 'text' + reset);
        }
        for (const params of [
            '',
            ';',
            '1',
            '8',
            '31;1',
            '0310',
            '38;5;256',
            '38;2;1;2',
            '48;2;1;2;999',
            '38;4;1',
            '38;5;-1',
            '38:2:1:2:3',
            Array(17).fill('0').join(';'),
        ]) {
            const invalid = `${esc}[${params}m`;
            expect(sanitizeServerLog(invalid)).toBe('\\x1b' + invalid.slice(1));
        }
        const longest = `${esc}[${[...Array(15).fill('000'), '0'].join(';')}m`;
        expect(longest.length).toBe(64);
        expect(sanitizeServerLog(longest)).toBe(longest + reset);
        const tooLong = `${esc}[${Array(16).fill('000').join(';')}m`;
        expect(sanitizeServerLog(tooLong)).toBe('\\x1b' + tooLong.slice(1));
        expect(sanitizeServerLog(`${esc}[31\u0007m`)).toBe('\\x1b[31\\x07m');
    });

    it.each(['request', 'daemon'] as const)(
        'sanitizes direct server_log imports on the %s surface with unchanged bounds',
        (surface) => {
            const memory = new WebAssembly.Memory({ initial: 1 });
            const state = surface === 'request' ? freshDispatchState() : freshDaemonState();
            const imports =
                surface === 'request'
                    ? buildHostImports({ memory }, state as ReturnType<typeof freshDispatchState>)
                    : buildDaemonImports({ memory }, state, {
                          isLeader: () => true,
                          epoch: () => 1n,
                          taskCount: () => 0,
                          nextFireMs: () => null,
                      });
            const log = (imports.env as Record<string, (...args: number[]) => number>).server_log;
            const output = vi.spyOn(console, 'info').mockImplementation(() => {});
            try {
                for (const [input, expected] of attacks) {
                    const bytes = new TextEncoder().encode(input);
                    new Uint8Array(memory.buffer).set(bytes);
                    expect(log(0, 0, bytes.length)).toBe(1);
                    expect(output).toHaveBeenLastCalledWith('[toil guest]', expected);
                }
                new Uint8Array(memory.buffer).fill(0x07, 0, 4097);
                expect(log(0, 0, 4096)).toBe(1);
                const worstCase = output.mock.lastCall![1] as string;
                expect(worstCase).toBe('\\x07'.repeat(4096));
                expect(worstCase.length).toBe(16384);
                expect(() => log(0, 0, 4097)).toThrow();
                new Uint8Array(memory.buffer).set([0xc0, 0xaf]);
                expect(() => log(0, 0, 2)).toThrow();
                new Uint8Array(memory.buffer)[0] = 0x61;
                for (let i = attacks.length + 1; i < 32; i++) expect(log(0, 0, 1)).toBe(1);
                expect(log(0, 0, 1)).toBe(0);
                expect(output).toHaveBeenCalledTimes(32);
            } finally {
                output.mockRestore();
            }
        },
    );
});

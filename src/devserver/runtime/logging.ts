// Only color/reset SGR is allowed to reach a terminal. Keep this grammar aligned
// with toil-backend's server_log sanitizer; the input is already capped at 4096 bytes.
function colorSequenceEnd(message: string, start: number): number {
    if (message.charCodeAt(start + 1) !== 0x5b) return -1;
    const limit = Math.min(message.length, start + 64);
    const params: number[] = [];
    let cursor = start + 2;
    while (cursor < limit) {
        let value = 0;
        let digits = 0;
        while (cursor < limit) {
            const code = message.charCodeAt(cursor);
            if (code < 0x30 || code > 0x39) break;
            if (++digits > 3) return -1;
            value = value * 10 + code - 0x30;
            cursor++;
        }
        if (digits === 0 || params.length === 16) return -1;
        params.push(value);
        const next = message.charCodeAt(cursor++);
        if (next === 0x3b) continue;
        if (next !== 0x6d || cursor > limit) return -1;
        for (let i = 0; i < params.length; i++) {
            const code = params[i];
            if (
                code === 0 ||
                (code >= 30 && code <= 37) ||
                code === 39 ||
                (code >= 40 && code <= 47) ||
                code === 49 ||
                (code >= 90 && code <= 97) ||
                (code >= 100 && code <= 107)
            )
                continue;
            if (code !== 38 && code !== 48) return -1;
            const mode = params[++i];
            const components = mode === 5 ? 1 : mode === 2 ? 3 : 0;
            if (components === 0) return -1;
            for (let j = 0; j < components; j++) {
                const component = params[++i];
                if (component === undefined || component > 255) return -1;
            }
        }
        return cursor;
    }
    return -1;
}

/** Make a guest message one terminal-safe record, preserving only bounded colors. */
export function sanitizeServerLog(message: string): string {
    const parts: string[] = [];
    let colored = false;
    for (let i = 0; i < message.length; i++) {
        const code = message.charCodeAt(i);
        if (code === 0x1b) {
            const end = colorSequenceEnd(message, i);
            if (end !== -1) {
                parts.push(message.slice(i, end));
                colored = true;
                i = end - 1;
                continue;
            }
        }
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
            parts.push('\\x' + code.toString(16).padStart(2, '0'));
        } else if (
            code === 0x061c ||
            code === 0x200e ||
            code === 0x200f ||
            (code >= 0x2028 && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069)
        ) {
            parts.push('\\u' + code.toString(16).padStart(4, '0'));
        } else {
            parts.push(message[i]);
        }
    }
    const safe = parts.join('');
    return colored && !safe.endsWith('\u001b[0m') ? safe + '\u001b[0m' : safe;
}

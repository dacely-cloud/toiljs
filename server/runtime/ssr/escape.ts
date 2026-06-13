/**
 * HTML escaping for edge-SSR hole values, byte-for-byte identical to
 * react-dom/server's `escapeTextForBrowser` (the regex `/["'&<>]/`). React
 * runs the SAME escaper for text children and attribute values, so a single
 * function serves both kinds. Matching React exactly is load-bearing: the
 * browser's `hydrateRoot` compares the server markup to its own first render,
 * and any escaping difference triggers a hydration mismatch.
 *
 * Note the entities: `'` becomes `&#x27;` (React's choice, NOT `&#39;` or
 * `&apos;`), and `"` becomes `&quot;`. Do not "simplify" these.
 */

@inline function needsEscape(c: i32): bool {
    // 0x22 " | 0x26 & | 0x27 ' | 0x3C < | 0x3E >
    return c == 0x22 || c == 0x26 || c == 0x27 || c == 0x3c || c == 0x3e;
}

/** React-exact HTML text/attribute escape. */
export function escapeHtml(s: string): string {
    let hit = false;
    for (let i = 0; i < s.length; i++) {
        if (needsEscape(s.charCodeAt(i))) {
            hit = true;
            break;
        }
    }
    if (!hit) return s;

    let out = '';
    let last = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        let rep: string = '';
        if (c == 0x22) rep = '&quot;';
        else if (c == 0x26) rep = '&amp;';
        else if (c == 0x27) rep = '&#x27;';
        else if (c == 0x3c) rep = '&lt;';
        else if (c == 0x3e) rep = '&gt;';
        else continue;
        out += s.substring(last, i);
        out += rep;
        last = i + 1;
    }
    out += s.substring(last, s.length);
    return out;
}

/**
 * Escape a JSON string for safe embedding inside a `<script>` element (the
 * `__toil_state` hydration blob). Neutralises `<`, `>`, `&` and the JS line
 * terminators U+2028/U+2029 to their `\uXXXX` forms so the JSON can never
 * close the script element or break the parse. Mirrors the standard
 * "serialize-javascript"/Next.js approach; the bytes stay valid JSON.
 */
export function escapeJsonForScript(json: string): string {
    let hit = false;
    for (let i = 0; i < json.length; i++) {
        const c = json.charCodeAt(i);
        if (c == 0x3c || c == 0x3e || c == 0x26 || c == 0x2028 || c == 0x2029) {
            hit = true;
            break;
        }
    }
    if (!hit) return json;

    let out = '';
    let last = 0;
    for (let i = 0; i < json.length; i++) {
        const c = json.charCodeAt(i);
        let rep: string = '';
        if (c == 0x3c) rep = '\\u003c';
        else if (c == 0x3e) rep = '\\u003e';
        else if (c == 0x26) rep = '\\u0026';
        else if (c == 0x2028) rep = '\\u2028';
        else if (c == 0x2029) rep = '\\u2029';
        else continue;
        out += json.substring(last, i);
        out += rep;
        last = i + 1;
    }
    out += json.substring(last, json.length);
    return out;
}

// Generated from server/runtime by scripts/gen-server-types.mjs.
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
/** React-exact HTML text/attribute escape. */
export declare function escapeHtml(s: string): string;
/**
 * Escape a JSON string for safe embedding inside a `<script>` element (the
 * `__toil_state` hydration blob). Neutralises `<`, `>`, `&` and the JS line
 * terminators U+2028/U+2029 to their `\uXXXX` forms so the JSON can never
 * close the script element or break the parse. Mirrors the standard
 * "serialize-javascript"/Next.js approach; the bytes stay valid JSON.
 */
export declare function escapeJsonForScript(json: string): string;

/**
 * Dev-server edge SSR: splice the guest `render` values into a route's
 * template-with-holes and serve real server-rendered HTML, mirroring the
 * production edge (`toil-backend/src/host/template/assemble.rs`).
 *
 * The templates are extracted once at dev startup against the LIVE (Vite-
 * transformed) dev shell (see `compiler/template-build.ts extractDevSsrTemplates`)
 * so the served markup boots the dev client and hydrates in place. At request
 * time the dev server runs the real `render` export (`WasmServerModule.
 * dispatchRender`), this module decodes the values envelope and splices each
 * value at its manifest-fixed offset. The hash-coherence guard the prod edge
 * enforces is skipped in dev: the guest and the template are built together
 * here, so there is no deploy skew to catch — only fail-safe envelopes (status
 * >= 500 or no slots) fall back to client rendering.
 */

/** One SSR route's spliceable template + its slot insertion points. */
export interface DevSsrTemplate {
    pattern: string;
    name: string;
    tmpl: Uint8Array;
    entries: { id: number; offset: number }[];
}

/** A matchable SSR route. */
export interface SsrRoute {
    /** Matches a request pathname (no query) to this route's template. */
    test: (pathname: string) => boolean;
    tmpl: Uint8Array;
    entries: { id: number; offset: number }[];
}

/** The pathname of a request URL (strip the query string). */
export function pathnameOf(url: string): string {
    const q = url.indexOf('?');
    return q < 0 ? url : url.slice(0, q);
}

/** Compile a route pattern (`/hello`, `/u/:name`, `/blog/[id]`, `/files/[...path]`,
 * `/*`) to a pathname matcher. Dynamic segments match one path segment; catch-all
 * (`[...x]` / `*`) matches the rest. Trailing slashes are ignored. */
function patternToTest(pattern: string): (pathname: string) => boolean {
    const norm = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
    let re = '';
    // Tokenise into literal runs and dynamic/catch-all holes.
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === ':') {
            // `:name` — one segment.
            i++;
            while (i < pattern.length && /[A-Za-z0-9_]/.test(pattern[i])) i++;
            re += '[^/]+';
        } else if (ch === '*') {
            re += '.*';
            i++;
        } else if (ch === '[') {
            const end = pattern.indexOf(']', i);
            const inner = end < 0 ? '' : pattern.slice(i + 1, end);
            re += inner.startsWith('...') ? '.*' : '[^/]+';
            i = end < 0 ? pattern.length : end + 1;
        } else {
            // Literal char, regex-escaped.
            re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            i++;
        }
    }
    const compiled = new RegExp(`^${re}$`);
    return (pathname: string): boolean => compiled.test(norm(pathname));
}

/** Build matchable SSR routes from the extracted dev templates. */
export function buildSsrRoutes(templates: readonly DevSsrTemplate[]): SsrRoute[] {
    return templates.map((t) => ({ test: patternToTest(t.pattern), tmpl: t.tmpl, entries: t.entries }));
}

/** A decoded guest values envelope. */
interface DecodedValues {
    status: number;
    headers: [string, string][];
    /** Slot value bytes keyed by numeric slot id. */
    values: Map<number, Uint8Array>;
}

/** Decode the guest values envelope (mirrors the prod host `decode_values`). All
 * fields little-endian, no padding. Returns null on a malformed/short buffer. */
function decodeValues(buf: Uint8Array): DecodedValues | null {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 0;
    const need = (n: number): boolean => o + n <= buf.byteLength;
    try {
        if (!need(2 + 32 + 2)) return null;
        const status = dv.getUint16(o, true);
        o += 2;
        o += 32; // template hash (coherence is built together in dev; not checked)
        const nHeaders = dv.getUint16(o, true);
        o += 2;
        const headers: [string, string][] = [];
        const dec = new TextDecoder();
        for (let i = 0; i < nHeaders; i++) {
            if (!need(4)) return null;
            const nameLen = dv.getUint16(o, true);
            const valLen = dv.getUint16(o + 2, true);
            o += 4;
            if (!need(nameLen + valLen)) return null;
            const name = dec.decode(buf.subarray(o, o + nameLen));
            o += nameLen;
            const val = dec.decode(buf.subarray(o, o + valLen));
            o += valLen;
            headers.push([name, val]);
        }
        if (!need(2)) return null;
        const nSlots = dv.getUint16(o, true);
        o += 2;
        const values = new Map<number, Uint8Array>();
        for (let i = 0; i < nSlots; i++) {
            if (!need(2 + 1 + 4)) return null;
            const id = dv.getUint16(o, true);
            o += 2;
            o += 1; // kind (the splice is kind-agnostic; the guest pre-escaped/stamped)
            const len = dv.getUint32(o, true);
            o += 4;
            if (!need(len)) return null;
            values.set(id, buf.subarray(o, o + len));
            o += len;
        }
        return { status, headers, values };
    } catch {
        return null;
    }
}

/** Splice ascending-offset inserts into the template (mirrors the host `assemble`). */
function splice(tmpl: Uint8Array, inserts: { offset: number; value: Uint8Array }[]): Uint8Array {
    const parts: Uint8Array[] = [];
    let prev = 0;
    for (const ins of inserts) {
        if (ins.offset > prev) parts.push(tmpl.subarray(prev, ins.offset));
        if (ins.value.length > 0) parts.push(ins.value);
        prev = ins.offset;
    }
    if (tmpl.length > prev) parts.push(tmpl.subarray(prev));
    return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

/** A spliced SSR response. */
export interface SsrResult {
    status: number;
    headers: [string, string][];
    html: Uint8Array;
}

/**
 * Decode the guest envelope and splice it into `route`'s template. Returns null
 * to fall back to client rendering: a fail-safe envelope (status >= 500, e.g. no
 * renderer matched), no slots, or a decode error.
 */
export function assembleSsr(route: SsrRoute, envelope: Uint8Array): SsrResult | null {
    const decoded = decodeValues(envelope);
    if (decoded === null) return null;
    if (decoded.status >= 500 || decoded.values.size === 0) return null;
    const inserts = route.entries
        .map((e) => ({ offset: e.offset, value: decoded.values.get(e.id) ?? new Uint8Array(0) }))
        .sort((a, b) => a.offset - b.offset);
    return { status: decoded.status, headers: decoded.headers, html: splice(route.tmpl, inserts) };
}

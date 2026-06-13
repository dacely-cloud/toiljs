/**
 * Build-time edge-SSR template extraction.
 *
 * After a route component is rendered to HTML with the marker components in
 * sentinel mode (`__setSsrBuild(true)`), the output carries PUA sentinel tokens
 * at every hole. This module scans that HTML, strips the tokens, records their
 * BYTE offsets, and emits:
 *
 *   - `<route>.tmpl`  — the stripped static scaffold (React's own bytes, holes
 *     removed); the edge mmaps this.
 *   - `<route>.slots` — the binary manifest the Rust host parses
 *     (`toil-backend/src/host/template/manifest.rs`).
 *
 * The repeat-region row sub-template + the holes' binding metadata are also
 * captured (for the guest `render()` codegen), but those do NOT go in `.slots`
 * (the host only needs insertion points; the guest pre-stamps repeat rows).
 *
 * The pure functions here (`extractFromHtml`, `encodeSlots`, `coherenceHash`,
 * `reactEscapeHtml`, `spliceTemplate`) are deterministic and unit-tested; the
 * `extractTemplates` orchestration drives a short-lived Vite SSR server, the
 * same pattern as `ssg.ts`.
 */

import { createHash } from 'node:crypto';

/** PUA sentinel framing, mirroring `src/client/ssr/markers.tsx`. */
const START = String.fromCharCode(0xe000);
const END = String.fromCharCode(0xe002);

export type SlotKind = 'text' | 'raw' | 'attr' | 'repeat';

/** Byte value of a kind on the wire / in `.slots`. Mirrors host `SlotKind`. */
export function kindByte(kind: SlotKind): number {
    switch (kind) {
        case 'text':
            return 0;
        case 'raw':
            return 1;
        case 'attr':
            return 2;
        case 'repeat':
            return 3;
    }
}

/** One extracted hole. `offset` is a byte offset into the enclosing template
 * (the `.tmpl` for top-level slots, or the row sub-template for nested ones). */
export interface SlotRecord {
    id: string;
    kind: SlotKind;
    offset: number;
    /** Repeat only: the captured single-row scaffold (bytes) ... */
    rowTemplate?: Buffer;
    /** ... and the holes inside that row, offsets relative to `rowTemplate`. */
    rowSlots?: SlotRecord[];
}

export interface Extracted {
    /** Stripped static scaffold; the mmap'd `.tmpl`. */
    tmpl: Buffer;
    /** Top-level holes in document order, byte offsets into `tmpl`. */
    slots: SlotRecord[];
}

interface ScanResult {
    text: string;
    byteLen: number;
    slots: SlotRecord[];
}

/** Scan one HTML string, stripping sentinel tokens and recording hole offsets.
 * Recurses into repeat regions to capture the row sub-template. */
function scan(html: string): ScanResult {
    let out = '';
    let byteLen = 0;
    const slots: SlotRecord[] = [];
    let i = 0;

    const emit = (chunk: string): void => {
        out += chunk;
        byteLen += Buffer.byteLength(chunk, 'utf8');
    };

    while (i < html.length) {
        const start = html.indexOf(START, i);
        if (start === -1) {
            emit(html.slice(i));
            break;
        }
        if (start > i) emit(html.slice(i, start));

        const kindChar = html[start + 1];
        const tokEnd = html.indexOf(END, start + 2);
        if (tokEnd === -1) throw new Error('toil ssr: unterminated sentinel token');
        const id = html.slice(start + 2, tokEnd);
        const afterTok = tokEnd + 1;

        if (kindChar === 'R') {
            // Repeat region: collect everything up to the matching close token.
            const closeTok = START + 'r' + id + END;
            const closeIdx = html.indexOf(closeTok, afterTok);
            if (closeIdx === -1) {
                throw new Error(`toil ssr: unterminated repeat region "${id}"`);
            }
            const innerHtml = html.slice(afterTok, closeIdx);
            const inner = scan(innerHtml);
            slots.push({
                id,
                kind: 'repeat',
                offset: byteLen, // region collapses to a zero-width insertion point
                rowTemplate: Buffer.from(inner.text, 'utf8'),
                rowSlots: inner.slots,
            });
            i = closeIdx + closeTok.length;
            continue;
        }

        const kind: SlotKind | null =
            kindChar === 't' ? 'text' : kindChar === 'h' ? 'raw' : kindChar === 'a' ? 'attr' : null;
        if (kind === null) {
            throw new Error(`toil ssr: unknown sentinel kind "${kindChar ?? ''}"`);
        }
        slots.push({ id, kind, offset: byteLen });
        i = afterTok;
    }

    return { text: out, byteLen, slots };
}

/** Strip sentinels from a rendered-with-markers HTML string into a `.tmpl` +
 * ordered slot records. */
export function extractFromHtml(html: string): Extracted {
    const r = scan(html);
    return { tmpl: Buffer.from(r.text, 'utf8'), slots: r.slots };
}

/** Assign stable numeric slot ids to top-level holes in document order. These
 * are the ids the host `.slots` and the guest `Slot` enum share. */
export function assignSlotIds(slots: SlotRecord[]): Map<string, number> {
    const ids = new Map<string, number>();
    let next = 0;
    for (const s of slots) {
        if (!ids.has(s.id)) ids.set(s.id, next++);
    }
    return ids;
}

/** Encode the `.slots` binary manifest the Rust host parses. Only top-level
 * slots are emitted (the host's insertion points); repeat row data is for the
 * guest codegen, not the host. */
export function encodeSlots(
    tmplLen: number,
    hash: Buffer,
    slots: SlotRecord[],
    slotIds: Map<string, number>,
): Buffer {
    if (hash.length !== 32) throw new Error('toil ssr: coherence hash must be 32 bytes');
    const buf = Buffer.alloc(4 + 2 + 2 + 4 + 32 + 2 + slots.length * 8);
    let o = 0;
    buf.write('TSLT', o, 'ascii'); // magic, read as u32 LE on the host
    o += 4;
    buf.writeUInt16LE(1, o); // version
    o += 2;
    buf.writeUInt16LE(0, o); // flags
    o += 2;
    buf.writeUInt32LE(tmplLen, o);
    o += 4;
    hash.copy(buf, o);
    o += 32;
    buf.writeUInt16LE(slots.length, o);
    o += 2;
    for (const s of slots) {
        const id = slotIds.get(s.id);
        if (id === undefined) throw new Error(`toil ssr: no slot id for "${s.id}"`);
        buf.writeUInt32LE(s.offset, o);
        o += 4;
        buf.writeUInt16LE(id, o);
        o += 2;
        buf.writeUInt8(kindByte(s.kind), o);
        o += 1;
        buf.writeUInt8(0, o); // reserved
        o += 1;
    }
    return buf;
}

/** Canonical serialisation of the slot structure (recursive), used by the
 * coherence hash so a change to any hole, kind, or nesting rotates it. */
function canonicalManifest(slots: SlotRecord[]): string {
    return JSON.stringify(
        slots.map((s) => ({
            id: s.id,
            kind: s.kind,
            offset: s.offset,
            row: s.rowSlots ? canonicalManifest(s.rowSlots) : undefined,
            rowLen: s.rowTemplate ? s.rowTemplate.length : undefined,
        })),
    );
}

/** Coherence hash binding the `.tmpl` + slot structure. Stored in `.slots` and
 * baked into the guest; the host 500s on a mismatch (deploy skew). */
export function coherenceHash(tmpl: Buffer, slots: SlotRecord[]): Buffer {
    return createHash('sha256')
        .update(tmpl)
        .update('\0')
        .update(canonicalManifest(slots), 'utf8')
        .digest();
}

/**
 * React-exact HTML escape (`react-dom/server` `escapeTextForBrowser`, regex
 * `/["'&<>]/`). The SAME function React uses for text AND attributes. Must stay
 * byte-identical to the guest's `server/runtime/ssr/escape.ts`, or hydration
 * mismatches. Used by the golden byte-identity test to simulate the guest.
 */
export function reactEscapeHtml(s: string): string {
    let out = '';
    let last = 0;
    for (let i = 0; i < s.length; i++) {
        let rep: string;
        switch (s.charCodeAt(i)) {
            case 34:
                rep = '&quot;';
                break;
            case 38:
                rep = '&amp;';
                break;
            case 39:
                rep = '&#x27;';
                break;
            case 60:
                rep = '&lt;';
                break;
            case 62:
                rep = '&gt;';
                break;
            default:
                continue;
        }
        out += s.slice(last, i) + rep;
        last = i + 1;
    }
    return last === 0 ? s : out + s.slice(last);
}

/** Generic splice: interleave template slices with hole values at ascending
 * byte offsets. Mirrors the Rust host `assemble`; used by the golden test (and
 * any tooling that needs to materialise a full page from a template + values).
 * `values` maps a byte offset to the bytes inserted there (offsets may repeat
 * is not allowed; pass them in `slots` order). */
export function spliceTemplate(
    tmpl: Buffer,
    inserts: { offset: number; value: Buffer }[],
): Buffer {
    const parts: Buffer[] = [];
    let prev = 0;
    for (const ins of inserts) {
        if (ins.offset > prev) parts.push(tmpl.subarray(prev, ins.offset));
        if (ins.value.length > 0) parts.push(ins.value);
        prev = ins.offset;
    }
    if (tmpl.length > prev) parts.push(tmpl.subarray(prev));
    return Buffer.concat(parts);
}

/**
 * Decode the `email_send` request blob the guest writes into wasm memory — the
 * v2 wire format, byte-for-byte the edge's (`email_send_import.rs::parse_request`
 * and `server/globals/email.ts`):
 *
 *   u16 to_len | u16 subject_len | u16 purpose_len | u32 body_len | u32 html_len
 *   [to][subject][purpose][body][html]      (14-byte LE header, then UTF-8 payloads)
 *
 * `html_len == 0` is a plain-text send. Returns `null` on truncation, a length
 * that overruns the blob, trailing garbage, or non-UTF-8 — all guest encode bugs
 * the caller maps to `BadRecipient`.
 */
export interface ParsedEmail {
    readonly to: string;
    readonly subject: string;
    readonly purpose: string;
    readonly body: string;
    readonly html: string;
}

const HEADER_LEN = 14;

export function parseEmailBlob(raw: Buffer): ParsedEmail | null {
    if (raw.length < HEADER_LEN) return null;
    const toLen = raw.readUInt16LE(0);
    const subjectLen = raw.readUInt16LE(2);
    const purposeLen = raw.readUInt16LE(4);
    const bodyLen = raw.readUInt32LE(6);
    const htmlLen = raw.readUInt32LE(10);

    const total = toLen + subjectLen + purposeLen + bodyLen + htmlLen;
    // Exact fit: the five payloads must consume the rest of the blob precisely.
    if (HEADER_LEN + total !== raw.length) return null;

    let off = HEADER_LEN;
    const take = (n: number): string | null => {
        const end = off + n;
        const slice = raw.subarray(off, end);
        // Reject invalid UTF-8 (Buffer.toString is lossy, so verify by round-trip).
        const s = slice.toString('utf8');
        if (Buffer.byteLength(s, 'utf8') !== n) return null;
        off = end;
        return s;
    };

    const to = take(toLen);
    const subject = take(subjectLen);
    const purpose = take(purposeLen);
    const body = take(bodyLen);
    const html = take(htmlLen);
    if (to === null || subject === null || purpose === null || body === null || html === null) {
        return null;
    }
    return { to, subject, purpose, body, html };
}

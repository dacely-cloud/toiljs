/**
 * Strict single-recipient check for the guest-supplied `to`, byte-for-byte the
 * edge's (`host/email.rs::valid_recipient`). Rejects header injection
 * (CR/LF/NUL), multiple addresses (comma, semicolon, whitespace, angle
 * brackets, quotes), and the obviously malformed, so a guest can never smuggle a
 * Bcc or a second envelope recipient into the provider call. Exactly one `@`,
 * non-empty local part, dotted domain.
 */
const FORBIDDEN = new Set(['\r', '\n', '\0', ',', ';', ' ', '\t', '<', '>', '"']);

export function validRecipient(s: string): boolean {
    if (s.length === 0 || Buffer.byteLength(s, 'utf8') > 320) return false;
    for (const ch of s) {
        if (FORBIDDEN.has(ch)) return false;
    }
    const parts = s.split('@');
    if (parts.length !== 2) return false; // not exactly one '@'
    const [local, domain] = parts;
    return (
        local.length > 0 &&
        domain.includes('.') &&
        !domain.startsWith('.') &&
        !domain.endsWith('.')
    );
}

/**
 * Lenient validation of the operator-supplied `from` (`host/email.rs::valid_from`):
 * trusted config, so the only hard requirement is no header injection; the
 * provider validates deliverability.
 */
export function validFrom(s: string): boolean {
    return (
        Buffer.byteLength(s, 'utf8') <= 320 &&
        s.includes('@') &&
        !s.includes('\r') &&
        !s.includes('\n') &&
        !s.includes('\0')
    );
}

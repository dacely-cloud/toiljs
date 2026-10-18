import createDOMPurify from 'dompurify';

// Keep a private instance so application DOMPurify hooks/configuration cannot
// change the framework's sanitization rules.
let purifier: ReturnType<typeof createDOMPurify> | undefined;

/** Sanitize HTML for browser DOM sinks, returning TrustedHTML when supported. */
export function sanitizeHtml(html: string): string | TrustedHTML {
    if (typeof window === 'undefined')
        throw new Error(
            'sanitizeHtml requires a browser DOM. Sanitize server HTML before rendering.',
        );
    purifier ??= createDOMPurify(window);
    return purifier.sanitize(html, { RETURN_TRUSTED_TYPE: true });
}

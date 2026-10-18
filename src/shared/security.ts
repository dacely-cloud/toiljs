/** Browser security defaults shared by the compiler and HTTP hosts. */
export const DEFAULT_COOP = 'same-origin';

/**
 * Script trust comes only from build-time hashes (production) or a fresh HTML
 * transform nonce (development). CSS inline styles support React's style prop.
 * wasm-unsafe-eval permits the client's password hashing without enabling eval.
 */
export function contentSecurityPolicy(
    scriptSources: readonly string[] = [],
    dev = false,
    extraSources: Readonly<Record<string, readonly string[]>> = {},
): string {
    const directives = [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        `script-src ${scriptSources.length ? scriptSources.join(' ') + " 'strict-dynamic'" : "'none'"}${scriptSources.length ? " 'wasm-unsafe-eval'" : ''}`,
        "script-src-attr 'none'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
        "worker-src 'self' blob:",
        "require-trusted-types-for 'script'",
        'trusted-types toil-script dompurify',
    ];
    const extensible = new Set([
        'connect-src',
        'img-src',
        'media-src',
        'font-src',
        'style-src',
        'frame-src',
        'child-src',
        'worker-src',
        'manifest-src',
        'trusted-types',
        'form-action',
        'frame-ancestors',
    ]);
    for (const [name, sources] of Object.entries(extraSources)) {
        if (!extensible.has(name))
            throw new Error(`Unsupported client.cspSources directive: ${name}`);
        if (
            !Array.isArray(sources) ||
            sources.some(
                (source) => typeof source !== 'string' || !source || /[\s;,<>]/.test(source),
            )
        ) {
            throw new Error(`Invalid client.cspSources value for ${name}`);
        }
        const index = directives.findIndex((directive) => directive.startsWith(name + ' '));
        if (index < 0) directives.push(`${name} 'self' ${sources.join(' ')}`.trim());
        else if (sources.length) directives[index] += ' ' + sources.join(' ');
    }
    return directives.join('; ');
}

export const DEFAULT_CSP = contentSecurityPolicy();

/** Only read this marker from trusted build files/templates, never request HTML. */
export function builtContentSecurityPolicy(html: string): string | null {
    return (
        /<meta name="toil-csp" content="([^"<>\r\n]+)">/
            .exec(html)?.[1]
            ?.replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&') ?? null
    );
}

/** Defaults fill absent headers; explicitly supplied application policies win. */
export function withSecurityHeaders(
    headers: readonly (readonly [string, string])[],
    policy = DEFAULT_CSP,
): (readonly [string, string])[] {
    const out = [...headers];
    if (!headers.some(([name]) => name.toLowerCase() === 'content-security-policy')) {
        out.push(['content-security-policy', policy]);
    }
    if (!headers.some(([name]) => name.toLowerCase() === 'cross-origin-opener-policy')) {
        out.push(['cross-origin-opener-policy', DEFAULT_COOP]);
    }
    return out;
}

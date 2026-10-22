import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Plugin } from 'vite';
import { contentSecurityPolicy, DEFAULT_COOP, type CoopPolicy } from 'toiljs/shared';

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** The marker lets HTTP hosts send this same policy in enforcement mode. */
export function injectSecurityPolicy(html: string, policy: string, coop: CoopPolicy = DEFAULT_COOP): string {
    const tags =
        (coop === DEFAULT_COOP ? '' : `<meta name="toil-coop" content="${coop}">\n`) +
        `<meta name="toil-csp" content="${escapeAttr(policy)}">\n` +
        // frame-ancestors is header-only; omit it from the meta policy.
        `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(policy.replace(/frame-ancestors [^;]+; /, ''))}">`;
    const head = /<head\b[^>]*>/i.exec(html);
    const charset = head
        ? /<meta\s+charset\s*=[^>]+>/i.exec(html.slice(head.index + head[0].length))
        : null;
    const at =
        charset && head
            ? head.index + head[0].length + charset.index + charset[0].length
            : head
              ? head.index + head[0].length
              : 0;
    return html.slice(0, at) + '\n' + tags + html.slice(at);
}

/** Hash only trusted build output, before request data can enter SSR slots. */
export function secureBuiltHtml(
    html: string,
    extraSources: Readonly<Record<string, readonly string[]>> = {},
    coop: CoopPolicy = DEFAULT_COOP,
): { html: string; policy: string } {
    const sources = new Set<string>();
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const attrs = match[1];
        if (/(?<![\w-])src\s*=/i.test(attrs)) {
            const integrity = /(?<![\w-])integrity\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
            for (const token of integrity?.split(/\s+/) ?? []) {
                if (/^sha(256|384|512)-[A-Za-z0-9+/]+=*$/.test(token)) sources.add(`'${token}'`);
            }
        } else {
            // Import-map integrity also applies to static module imports, which
            // browsers check independently of the root script's authorization.
            if (/\btype\s*=\s*["']importmap["']/i.test(attrs)) {
                const map = JSON.parse(match[2]) as { integrity?: Record<string, string> };
                for (const value of Object.values(map.integrity ?? {})) {
                    for (const token of value.split(/\s+/)) {
                        if (/^sha(256|384|512)-[A-Za-z0-9+/]+=*$/.test(token))
                            sources.add(`'${token}'`);
                    }
                }
            }
            // HTML parsing normalizes CRLF/CR to LF before CSP hashes are checked.
            const body = match[2].replace(/\r\n?/g, '\n');
            sources.add(`'sha384-${createHash('sha384').update(body).digest('base64')}'`);
        }
    }
    const policy = contentSecurityPolicy([...sources], false, extraSources);
    return { html: injectSecurityPolicy(html, policy, coop), policy };
}

/** Runs after Vite/React have inserted their development scripts. */
export function devSecurityPlugin(
    extraSources: Readonly<Record<string, readonly string[]>> = {},
    coop: CoopPolicy = DEFAULT_COOP,
): Plugin {
    const requestNonce = new AsyncLocalStorage<string>();
    return {
        name: 'toil:security-dev',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use((_request, response, next) => {
                const nonce = randomBytes(24).toString('base64');
                response.setHeader(
                    'Content-Security-Policy',
                    contentSecurityPolicy([`'nonce-${nonce}'`], true, extraSources),
                );
                response.setHeader('Cross-Origin-Opener-Policy', coop);
                requestNonce.run(nonce, next);
            });
        },
        transformIndexHtml: {
            order: 'post',
            handler(html) {
                const nonce = requestNonce.getStore() ?? randomBytes(24).toString('base64');
                const out = html.replace(/<script\b([^>]*)>/gi, (_tag, attrs: string) => {
                    const clean = attrs.replace(
                        /\snonce(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi,
                        '',
                    );
                    return `<script nonce="${nonce}"${clean}>`;
                });
                return injectSecurityPolicy(
                    out,
                    contentSecurityPolicy([`'nonce-${nonce}'`], true, extraSources),
                    coop,
                );
            },
        },
    };
}

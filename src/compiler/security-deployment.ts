import fs from 'node:fs';
import path from 'node:path';

import type { ResolvedToilConfig } from './config.js';

/** A response-header operation from the completed build's static-host rules. */
interface HeaderOperation {
    readonly name: string;
    readonly value: string | null;
}

/** A URL pattern and its response-header operations, in deployment order. */
interface HeaderRule {
    readonly pattern: string;
    readonly headers: HeaderOperation[];
}

/** Read generated rules, including project plugins' overrides and removals. */
function headerRules(source: string): HeaderRule[] {
    const rules: HeaderRule[] = [];
    let current: HeaderRule | undefined;
    for (const line of source.split(/\r?\n/)) {
        const text = line.trim();
        if (!text || text.startsWith('#')) continue;
        if (!/^\s/.test(line)) {
            current = { pattern: text, headers: [] };
            rules.push(current);
            continue;
        }
        if (current === undefined) continue;
        const removal = /^!\s+([^\s:]+)$/.exec(text);
        if (removal) {
            current.headers.push({ name: removal[1], value: null });
            continue;
        }
        const header = /^([^\s:]+):\s*(.*)$/.exec(text);
        if (header) current.headers.push({ name: header[1], value: header[2] });
    }
    return rules.filter((rule) => rule.headers.length > 0);
}

/** Preserve exact paths and case-sensitive wildcard matching in Cloudflare expressions. */
function match(field: string, pattern: string): string {
    return `${field} ${pattern.includes('*') ? 'strict wildcard' : 'eq'} ${JSON.stringify(pattern)}`;
}

/** Translate supported static-host patterns without guessing a site's hostname. */
function expression(pattern: string, hostname: string | undefined): string | null {
    const absolute = /^https:\/\/([^/]+)(\/.*)?$/.exec(pattern);
    const host = absolute?.[1] ?? hostname;
    const pathname = absolute ? (absolute[2] ?? '/') : pattern;
    if (!pathname.startsWith('/') || /:[A-Za-z_]\w*/.test(pathname)) return null;
    const pathMatch = match('http.request.uri.path', pathname);
    return host ? `(${match('http.host', host)}) and (${pathMatch})` : pathMatch;
}

/**
 * Format copyable deployment steps from the final generated headers, not app-specific rules.
 * Builds without a CSP or COOP policy have no security setup message.
 */
export function securityDeploymentInstructions(headers: string, siteUrl?: string): string | null {
    const rules = headerRules(headers);
    if (
        !rules.some((rule) =>
            rule.headers.some(
                (header) =>
                    /^(content-security-policy|cross-origin-opener-policy)(-report-only)?$/i.test(
                        header.name,
                    ) &&
                    header.value !== null &&
                    header.value !== '',
            ),
        )
    )
        return null;
    const site = siteUrl && URL.canParse(siteUrl) ? new URL(siteUrl) : undefined;
    const hostname =
        site && ['https:', 'http:'].includes(site.protocol) ? site.hostname : undefined;
    const lines = [
        '\nBrowser security deployment setup',
        'Cloudflare Pages static hosting: deploy the generated _headers with the client output.',
        'Other hosts must send the generated response headers; uploading _headers alone does not apply them.',
        'toiljs start applies the framework headers automatically. Pages Functions / Workers must set headers in their handlers.',
        '',
        'Cloudflare: Rules > Transform Rules > Modify Response Header > Create rule.',
        'Create the following rules in order using Custom filter expression > Edit expression.',
        'Choose Set static for each header value, or Remove where indicated, then Deploy.',
    ];
    if (!hostname)
        lines.push(
            'No site hostname configured in client.seo.url: scope these expressions to your deployment hostname if needed.',
        );
    for (const [index, rule] of rules.entries()) {
        lines.push('', `${index + 1}. ${rule.pattern}`);
        const filter = expression(rule.pattern, hostname);
        if (
            filter === null ||
            rule.headers.some((header) => /:[A-Za-z_]\w*/.test(header.value ?? ''))
        ) {
            lines.push(
                'This rule uses a pattern or placeholder requiring configuration at the origin or in a Worker.',
                rule.pattern,
                ...rule.headers.map((header) =>
                    header.value === null
                        ? `  ! ${header.name}`
                        : `  ${header.name}: ${header.value}`,
                ),
            );
            continue;
        }
        lines.push('Expression:', filter);
        for (const header of rule.headers) {
            if (header.value === null) lines.push(`Remove: ${header.name}`);
            else lines.push(`Set static: ${header.name}`, 'Value:', header.value);
        }
    }
    lines.push(
        '',
        'Keep the generated HTML CSP meta policy, import map, and integrity attributes when deploying.',
        '',
    );
    return lines.join('\n');
}

/** Log once after the production client build and all project plugins have completed. */
export function logSecurityDeployment(cfg: ResolvedToilConfig): void {
    const file = path.resolve(cfg.root, cfg.outDir, '_headers');
    if (!fs.existsSync(file)) return;
    const instructions = securityDeploymentInstructions(
        fs.readFileSync(file, 'utf8'),
        cfg.seo?.url,
    );
    if (instructions !== null) process.stdout.write(instructions + '\n');
}

import fs from 'node:fs';
import path from 'node:path';

import pc from 'picocolors';

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
export function securityDeploymentInstructions(
    headers: string,
    siteUrl?: string,
    color: boolean = pc.isColorSupported,
): string | null {
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
    const colors = pc.createColors(color);
    const separator = `  ${colors.dim('─'.repeat(64))}`;
    const lines = [
        '',
        `  ${colors.bold(colors.cyan('Browser security deployment setup'))}`,
        separator,
        '',
        `  ${colors.bold('Hosting')}`,
        ...[
            ['Cloudflare Pages', 'Deploy _headers with the client output.'],
            ['toiljs start', 'Framework headers apply automatically.'],
            ['Other hosts', 'Configure response headers on your host.'],
            ['', 'Uploading _headers alone does not apply them.'],
            ['Functions / Workers', 'Set response headers in your handlers.'],
        ].map(([label, description]) => `    ${colors.bold(label.padEnd(21))}${description}`),
        '',
        `  ${colors.bold('Cloudflare response header rules')}`,
        `    Rules ${colors.dim('›')} Transform Rules ${colors.dim('›')} Modify Response Header ${colors.dim('›')} Create rule`,
        '',
        '    Create the rules below in order.',
        `    Select ${colors.bold('Custom filter expression')} ${colors.dim('›')} ${colors.bold('Edit expression')}.`,
        `    Choose ${colors.green('Set static')} or ${colors.yellow('Remove')} as shown, then ${colors.bold('Deploy')}.`,
        '',
    ];
    if (!hostname)
        lines.push(
            `    ${colors.yellow('No site hostname configured')} in client.seo.url.`,
            '    Scope these expressions to your deployment hostname if needed.',
            '',
        );
    for (const [index, rule] of rules.entries()) {
        lines.push(
            separator,
            '',
            `  ${colors.bold(colors.cyan(`${index + 1}. ${rule.pattern}`))}`,
            '',
        );
        const filter = expression(rule.pattern, hostname);
        if (
            filter === null ||
            rule.headers.some((header) => /:[A-Za-z_]\w*/.test(header.value ?? ''))
        ) {
            lines.push(
                `    ${colors.yellow('Configure at the origin or in a Worker')}`,
                '    This rule uses a pattern or placeholder requiring configuration there.',
                '',
                `      ${rule.pattern}`,
                ...rule.headers.map((header) =>
                    header.value === null
                        ? `        ! ${header.name}`
                        : `        ${header.name}: ${header.value}`,
                ),
                '',
            );
            continue;
        }
        lines.push(`    ${colors.dim('Expression')}`, `      ${filter}`, '');
        for (const header of rule.headers) {
            if (header.value === null)
                lines.push(`    ${colors.yellow('Remove')}  ${colors.bold(header.name)}`, '');
            else
                lines.push(
                    `    ${colors.green('Set static')}  ${colors.bold(header.name)}`,
                    `      ${colors.dim('Value')}`,
                    `      ${header.value}`,
                    '',
                );
        }
    }
    lines.push(
        separator,
        '',
        `  ${colors.bold('When deploying')}`,
        '    Keep the generated HTML CSP meta policy, import map, and integrity attributes.',
        '    Expressions and header values above are complete; copy each as a single value.',
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

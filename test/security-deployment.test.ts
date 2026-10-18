import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/compiler/config.js';
import { build } from '../src/compiler/index.js';
import { secureBuiltHtml } from '../src/compiler/security.js';
import {
    logSecurityDeployment,
    securityDeploymentInstructions,
} from '../src/compiler/security-deployment.js';

const roots: string[] = [];

/** Register an isolated project for cleanup, including generated build output. */
function project(): string {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.toil-deployment-test-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'client/routes'), { recursive: true });
    fs.mkdirSync(path.join(root, 'client/public'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'client/public/index.html'),
        '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
    );
    fs.writeFileSync(
        path.join(root, 'client/routes/index.tsx'),
        'export default function Home() { return <h1>Deployment fixture</h1>; }',
    );
    return root;
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('generic security deployment instructions', () => {
    it('uses each project hostname and complete generated policy without canned app rules', () => {
        for (const hostname of ['shop.example.org', 'portal.example.net']) {
            const { policy } = secureBuiltHtml('<head><script>window.boot=true</script></head>', {
                'connect-src': [`wss://socket.${hostname}`],
                'frame-src': [`https://embed.${hostname}`],
            });
            const output = securityDeploymentInstructions(
                `/*\n  Content-Security-Policy: ${policy}\n  Cross-Origin-Opener-Policy: same-origin\n`,
                `https://${hostname}/app/`,
            );
            expect(output).toContain(`http.host eq "${hostname}"`);
            expect(output).toContain(`Value:\n${policy}`);
            expect(output).toContain('Set static: Cross-Origin-Opener-Policy\nValue:\nsame-origin');
            expect(output).not.toMatch(/nerva|dacely|localhost|__.*preview/i);
        }
    });

    it('preserves custom paths, absolute host rules, values and removal order', () => {
        const output = securityDeploymentInstructions(
            [
                '# Custom production rules',
                '/*',
                "  Content-Security-Policy: default-src 'none'",
                '  Cross-Origin-Opener-Policy: same-origin',
                '/App/Workers/*',
                "  Content-Security-Policy: script-src 'self'",
                'https://identity.example.net/callback',
                '  Cross-Origin-Opener-Policy: same-origin-allow-popups',
                '/app/consent',
                '  ! Cross-Origin-Opener-Policy',
            ].join('\r\n'),
            'https://shop.example.org',
        );
        expect(output).toContain('http.request.uri.path strict wildcard "/App/Workers/*"');
        expect(output).toContain(
            '(http.host eq "identity.example.net") and (http.request.uri.path eq "/callback")',
        );
        expect(output).toContain('Value:\nsame-origin-allow-popups');
        expect(output).toContain('Remove: Cross-Origin-Opener-Policy');
        expect(output?.indexOf('2. /App/Workers/*')).toBeLessThan(
            output?.indexOf('4. /app/consent') ?? 0,
        );
    });

    it('does not invent a hostname or print security steps when no policy is present', () => {
        expect(securityDeploymentInstructions('')).toBeNull();
        expect(securityDeploymentInstructions('/*\n  Cache-Control: max-age=0')).toBeNull();
        expect(securityDeploymentInstructions('/*\n  ! Content-Security-Policy')).toBeNull();
        const output = securityDeploymentInstructions(
            '/*\n  CROSS-ORIGIN-OPENER-POLICY: same-origin',
        );
        expect(output).toContain('No site hostname configured');
        expect(output).not.toContain('http.host');
    });

    it('shows placeholder rules without misrepresenting them as static values', () => {
        const output = securityDeploymentInstructions(
            [
                '/*',
                '  Cross-Origin-Opener-Policy: same-origin',
                '/projects/:project',
                '  X-Project: :project',
            ].join('\n'),
        );
        expect(output).toContain('requiring configuration at the origin or in a Worker');
        expect(output).toContain('X-Project: :project');
        expect(output).not.toContain('Set static: X-Project');
    });

    it('reads the configured output directory and stays silent without a generated policy', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-deployment-test-'));
        roots.push(root);
        fs.writeFileSync(
            path.join(root, 'toil.config.mjs'),
            'export default { client: { outDir: "dist/site", seo: { url: "https://custom.example.org" } } };',
        );
        const cfg = await loadConfig({ root });
        const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        logSecurityDeployment(cfg);
        expect(stdout).not.toHaveBeenCalled();
        fs.mkdirSync(path.join(root, 'dist/site'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dist/site/_headers'), '/*\n  Content-Type: text/html');
        logSecurityDeployment(cfg);
        expect(stdout).not.toHaveBeenCalled();
        fs.writeFileSync(
            path.join(root, 'dist/site/_headers'),
            '/*\n  Cross-Origin-Opener-Policy: same-origin',
        );
        logSecurityDeployment(cfg);
        expect(stdout).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining('http.host eq "custom.example.org"'),
        );
    });

    it('logs final project-plugin rules once after a real production build', async () => {
        const root = project();
        const finalHeaders =
            "/*\n  Content-Security-Policy: default-src 'none'\n/consent\n  Cross-Origin-Opener-Policy: unsafe-none\n";
        const file = path.join(root, 'dist/site/_headers');
        fs.writeFileSync(
            path.join(root, 'toil.config.mjs'),
            `
            import fs from 'node:fs';
            export default { client: {
                outDir: 'dist/site', images: false, fonts: false,
                seo: { url: 'https://fixture.example.org' },
                vite: { logLevel: 'silent', plugins: [{ name: 'custom-response-headers', enforce: 'post',
                    closeBundle() { fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(finalHeaders)}); }
                }] }
            } };
        `,
        );
        const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        await build({ root });
        const logs = stdout.mock.calls
            .map(([message]) => String(message))
            .filter((message) => message.includes('Browser security deployment setup'));
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('http.host eq "fixture.example.org"');
        expect(logs[0]).toContain('http.request.uri.path eq "/consent"');
        expect(logs[0]).toContain("Value:\ndefault-src 'none'");
        expect(logs[0]).toContain('Value:\nunsafe-none');
    }, 30000);

    it('does not log stale client headers during a server-only build', async () => {
        const root = project();
        fs.mkdirSync(path.join(root, 'build/client'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'build/client/_headers'),
            '/*\n  Cross-Origin-Opener-Policy: same-origin',
        );
        const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        await build({ root, serverOnly: true });
        expect(
            stdout.mock.calls.some(([message]) =>
                String(message).includes('Browser security deployment setup'),
            ),
        ).toBe(false);
    }, 30000);
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    builtContentSecurityPolicy,
    contentSecurityPolicy,
    DEFAULT_CSP,
    withSecurityHeaders,
} from '../src/shared/security';
import { devSecurityPlugin, secureBuiltHtml } from '../src/compiler/security';
import {
    assembleRouteSsr,
    prepareSsrResponse,
    prepareWasmResponse,
} from '../src/devserver/http/runtime';

const script = 'window.appBooted = true;\r\n';
const digest = createHash('sha384').update(script.replace(/\r\n/g, '\n')).digest('base64');

describe('default browser security', () => {
    it('authorizes only built inline hashes and integrity-pinned entry scripts', () => {
        const out = secureBuiltHtml(
            `<html><head><meta charset="utf-8"></head><body><script>${script}</script><script src="/entry.js" integrity="sha384-YWJj"></script></body></html>`,
        );
        expect(out.policy).toContain(`'sha384-${digest}'`);
        expect(out.policy).toContain("'sha384-YWJj' 'strict-dynamic'");
        expect(out.policy).not.toContain("script-src 'self'");
        expect(out.policy).not.toContain("'unsafe-eval'");
        expect(out.policy).toContain("require-trusted-types-for 'script'");
        expect(out.policy).toContain('trusted-types toil-script dompurify');
        expect(builtContentSecurityPolicy(out.html)).toBe(out.policy);
        expect(out.html.indexOf('charset=')).toBeLessThan(out.html.indexOf('http-equiv='));
        expect(out.html.indexOf('http-equiv=')).toBeLessThan(out.html.indexOf('<script'));
    });

    it('authorizes integrity-pinned static and lazy module imports', () => {
        const out = secureBuiltHtml(
            '<head><script type="importmap">{"integrity":{"/vendor.js":"sha384-dmVuZG9y","/lazy.js":"sha384-bGF6eQ=="}}</script></head>',
        );
        expect(out.policy).toContain("'sha384-dmVuZG9y'");
        expect(out.policy).toContain("'sha384-bGF6eQ=='");
    });

    it('rotates cached development SSR nonces before inserting any request data', () => {
        const nonce = 'A'.repeat(32);
        const policy = contentSecurityPolicy([`'nonce-${nonce}'`], true);
        const html = `<head><meta name="toil-csp" content="${policy}"></head><script nonce="${nonce}">window.ok=1</script>`;
        const route = { test: () => true, entries: [], tmpl: new TextEncoder().encode(html) };
        const request = { method: 'GET', path: '/', headers: [], body: new Uint8Array() } as const;
        const first = assembleRouteSsr(route, null, request)!;
        const second = assembleRouteSsr(route, null, request)!;
        expect(first.headers).not.toEqual(second.headers);
        expect(first.html.length).toBe(route.tmpl.length);
        expect(new TextDecoder().decode(first.html)).not.toContain(nonce);
        expect(new TextDecoder().decode(route.tmpl)).toBe(html);
    });

    it('extends resource origins without weakening script or DOM enforcement', () => {
        const extra = {
            'connect-src': ['https://api.example.com'],
            'frame-src': ['https://widget.example.com'],
        };
        const out = secureBuiltHtml('<head><script>window.ok=1</script></head>', extra);
        expect(out.policy).toContain("connect-src 'self' https://api.example.com");
        expect(out.policy).toContain("frame-src 'self' https://widget.example.com");
        expect(builtContentSecurityPolicy(out.html)).toBe(out.policy);
        expect(() =>
            contentSecurityPolicy([], false, { 'script-src': ["'unsafe-eval'"] }),
        ).toThrow();
        expect(() =>
            contentSecurityPolicy([], false, { 'connect-src': ['https://x;script-src'] }),
        ).toThrow();
    });

    it('fills defaults case-insensitively while preserving explicit policies', () => {
        expect(withSecurityHeaders([])).toContainEqual([
            'cross-origin-opener-policy',
            'same-origin',
        ]);
        const headers = [
            ['Content-Security-Policy', "default-src 'none'"],
            ['CROSS-ORIGIN-OPENER-POLICY', 'same-origin-allow-popups'],
        ] as const;
        expect(withSecurityHeaders(headers)).toEqual(headers);
        expect(withSecurityHeaders([]).some(([k]) => k === 'strict-transport-security')).toBe(
            false,
        );
    });

    it('covers WASM and SSR responses, including empty HEAD responses', () => {
        const wasm = prepareWasmResponse(
            '.',
            { status: 200, headers: [], body: new Uint8Array(), sendfile: null },
            'toil',
        );
        expect(wasm.headers).toContainEqual(['content-security-policy', DEFAULT_CSP]);
        const secured = secureBuiltHtml('<head></head><body><script>window.ok=1</script></body>');
        const route = {
            test: () => true,
            entries: [],
            tmpl: new TextEncoder().encode(secured.html),
        };
        const out = assembleRouteSsr(route, null, {
            method: 'HEAD',
            path: '/',
            headers: [],
            body: new Uint8Array(),
        })!;
        expect(out.headers).toContainEqual(['content-security-policy', secured.policy]);
        const head = prepareSsrResponse(out, true, 'toil');
        expect(head.body.length).toBe(0);
        expect(head.headers).toContainEqual(['content-security-policy', secured.policy]);
    });

    it('uses fresh development nonces without unsafe-inline scripts or unsafe-eval', async () => {
        const plugin = devSecurityPlugin();
        const hook = plugin.transformIndexHtml as { handler: (html: string) => string };
        const source =
            '<head></head><script type="module" src="/entry.tsx"></script><script>window.refresh=1</script>';
        const first = hook.handler(source);
        const second = hook.handler(source);
        const a = builtContentSecurityPolicy(first)!;
        expect(a).not.toBe(builtContentSecurityPolicy(second));
        const nonce = /'nonce-([^']+)'/.exec(a)![1];
        expect(
            first.match(new RegExp(`nonce="${nonce.replace(/[+]/g, '\\+')}"`, 'g')),
        ).toHaveLength(2);
        expect(a.split('; ').find((x) => x.startsWith('script-src '))).not.toContain(
            'unsafe-inline',
        );
        expect(a).toContain('ws: wss:');
        expect(contentSecurityPolicy()).not.toContain('ws: wss:');
    });
});

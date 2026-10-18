import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { remote } from 'webdriverio';
import { createServer } from 'vite';
import { build } from '../src/compiler/index';
import { loadConfig } from '../src/compiler/config';
import { createViteConfig } from '../src/compiler/vite';
import { generate } from '../src/compiler/generate';
import { extractDevSsrTemplates } from '../src/compiler/template-build';
import { startBuiltServer } from 'toiljs/devserver';
import { startBackend } from '../src/backend/index';
import { startDevServer } from '../src/devserver/server';

describe.runIf(process.env.TOILJS_BROWSER_TESTS === '1')('browser security defaults', () => {
    let root: string;
    let browser: Awaited<ReturnType<typeof remote>>;
    const watchers: fs.FSWatcher[] = [];
    let restoreWatch: (() => void) | undefined;
    function write(rel: string, content: string): void {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    async function freePort(): Promise<number> {
        const server = net.createServer();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return port;
    }

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(process.cwd(), '.toil-security-test-'));
        const watch = fs.watch.bind(fs);
        const spy = vi.spyOn(fs, 'watch').mockImplementation(((
            file: fs.PathLike,
            ...args: unknown[]
        ) => {
            const watcher = Reflect.apply(watch, fs, [file, ...args]);
            if (String(file).startsWith(root)) watchers.push(watcher);
            return watcher;
        }) as typeof fs.watch);
        restoreWatch = () => spy.mockRestore();
        write('toil.config.mjs', 'export default {client: {seo: {url: "https://example.com"}}};');
        write(
            'client/public/index.html',
            '<!doctype html><html><head><meta charset="utf-8"><script>window.trustedBoot=true</script></head><body><div id="root"></div></body></html>',
        );
        write(
            'client/routes/index.tsx',
            `
import { useState } from 'react';
import { Script, Link, RawHtml, Island } from 'toiljs/client';
export const ssr = true;
export default function Home() {
 const [count, setCount] = useState(0);
 return <main><h1>Secure app</h1><button onClick={()=>setCount(count+1)}>Count {count}</button>
 <Link href="/other">Other</Link>
 <Island><RawHtml id="raw" html={'<b id="safe-html">safe</b>'} /></Island>
 <Script id="inline-test">{'window.inlineLoaded = true'}</Script>
 <Script src="/external.js" />
 <Script id="json-data" type="application/json">{'{"safe":true}'}</Script>
 </main>;
}`,
        );
        write(
            'client/routes/other.tsx',
            'export default function Other(){return <h1>Lazy route</h1>;}',
        );
        write(
            'client/routes/devssr.tsx',
            'export const ssr = true; export default function Page(){return <h1>Dev SSR</h1>;}',
        );
        write('client/public/external.js', 'window.externalLoaded = true;');
        await build({ root });
        // Add attacker markup AFTER the compiler has fixed script trust.
        const shell = fs.readFileSync(path.join(root, 'build/client/index.html'), 'utf8');
        write(
            'build/client/injected.html',
            shell.replace(
                '</body>',
                '<script>window.injectedInline=true</script><script src="/untrusted.js"></script><img src="/missing-image" onerror="window.injectedHandler=true"></body>',
            ),
        );
        write('build/client/untrusted.js', 'window.injectedExternal=true;');
        const runtime = path.relative(root, path.resolve('server/runtime')).replace(/\\/g, '/');
        write(
            'native.ts',
            `
import { Server } from '${runtime}/env/Server';
import { ToilHandler } from '${runtime}/handlers/ToilHandler';
import { Request } from '${runtime}/request';
import { Response } from '${runtime}/response';
class Handler extends ToilHandler {
 handle(req: Request): Response {
   return req.path == '/api' ? Response.json('{"ok":true}') : Response.unhandled();
 }
}
Server.handler = (): ToilHandler => new Handler();
export { handle } from '${runtime}/exports/index';
`,
        );
        const compiled = spawnSync(
            process.execPath,
            [
                path.resolve('node_modules/toilscript/bin/toilscript.js'),
                path.join(root, 'native.ts'),
                '-o',
                path.join(root, 'security.wasm'),
                '--runtime',
                'stub',
                '--memoryBase',
                '65536',
            ],
            { encoding: 'utf8' },
        );
        expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
        browser = await remote({
            logLevel: 'error',
            capabilities: {
                browserName: 'chrome',
                'goog:chromeOptions': {
                    binary: process.env.CHROME_BIN ?? '/usr/bin/google-chrome',
                    args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
                },
            },
        });
    }, 60000);

    afterAll(async () => {
        if (browser) await browser.deleteSession();
        for (const watcher of watchers) watcher.close();
        restoreWatch?.();
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    async function checkApp(origin: string): Promise<void> {
        const response = await fetch(origin);
        const policy = response.headers.get('content-security-policy')!;
        expect(policy).toContain("'strict-dynamic'");
        expect(policy).not.toContain("script-src 'none'");
        expect(policy).toContain("require-trusted-types-for 'script'");
        expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
        expect(response.headers.has('strict-transport-security')).toBe(false);
        const head = await fetch(origin, { method: 'HEAD' });
        expect(head.headers.get('content-security-policy')).toContain("'strict-dynamic'");
        await browser.url(origin);
        try {
            await browser.waitUntil(
                async () =>
                    browser.execute(() =>
                        Boolean((window as any).inlineLoaded && (window as any).externalLoaded),
                    ),
                { timeout: 15000 },
            );
        } catch (error) {
            console.log((await browser.getPageSource()).slice(-2000));
            console.log(await browser.getLogs('browser'));
            throw error;
        }
        expect(await browser.execute(() => window.crossOriginIsolated)).toBe(false); // COOP does not opt into COEP.
        const blocked = await browser.execute(() => {
            let html = false,
                script = false,
                policy = false;
            try {
                document.createElement('div').innerHTML = '<img src=x onerror="window.pwned=1">';
            } catch {
                html = true;
            }
            try {
                document.createElement('script').src = '/external.js';
            } catch {
                script = true;
            }
            try {
                (window as any).trustedTypes.createPolicy('unapproved', {
                    createHTML: (x: string) => x,
                });
            } catch {
                policy = true;
            }
            return { html, script, policy };
        });
        expect(blocked).toEqual({ html: true, script: true, policy: true });
        expect(await browser.$('#safe-html').getText()).toBe('safe');
        expect(await browser.$('script[data-toil-script="json-data"]').getProperty('text')).toBe(
            '{"safe":true}',
        );
        await browser.$('button').click();
        await browser.waitUntil(async () => (await browser.$('button').getText()) === 'Count 1');
        await browser.$('a[href="/other"]').click();
        await browser.waitUntil(async () => (await browser.$('h1').getText()) === 'Lazy route');
    }

    it('enforces security while hydrating SSR and loading scripts and lazy routes in production', async () => {
        for (const threads of [1, 2]) {
            const port = await freePort();
            const server = await startBuiltServer({
                root,
                staticRoot: path.join(root, 'build/client'),
                wasmFile: path.join(root, 'security.wasm'),
                port,
                threads,
            });
            try {
                const origin = `http://127.0.0.1:${port}/`;
                const html = await (await fetch(origin)).text();
                expect(html).toContain('<main><h1>Secure app</h1>');
                await checkApp(origin);
                const api = await fetch(origin + 'api');
                expect(api.headers.get('content-security-policy')).toContain("script-src 'none'");
                expect(api.headers.get('cross-origin-opener-policy')).toBe('same-origin');
                await browser.url(origin + 'injected.html');
                await browser.waitUntil(async () =>
                    browser.execute(() => Boolean((window as any).trustedBoot)),
                );
                expect(
                    await browser.execute(() =>
                        Boolean(
                            (window as any).injectedInline ||
                            (window as any).injectedExternal ||
                            (window as any).injectedHandler,
                        ),
                    ),
                ).toBe(false);
            } finally {
                await browser.url('about:blank');
                await server.close();
            }
        }
        const headers = fs.readFileSync(path.join(root, 'build/client/_headers'), 'utf8');
        expect(headers).toContain('Cross-Origin-Opener-Policy: same-origin');
        expect(headers).toContain("require-trusted-types-for 'script'");
    }, 60000);

    it('enforces the defaults through the standalone static backend', async () => {
        const port = await freePort();
        const server = await startBackend({ root: path.join(root, 'build/client'), port });
        try {
            await checkApp(`http://127.0.0.1:${port}/`);
        } finally {
            await browser.url('about:blank');
            await server.close();
        }
    }, 30000);

    it('enforces the defaults through the Vite proxy with working HMR', async () => {
        const cfg = await loadConfig({ root });
        generate(cfg);
        const vite = await createServer({
            ...(await createViteConfig(cfg)),
            server: { port: 0, host: '127.0.0.1' },
        });
        await vite.listen();
        const vitePort = (vite.httpServer!.address() as net.AddressInfo).port;
        await checkApp(`http://127.0.0.1:${vitePort}/`);
        const port = await freePort();
        const devShell = await vite.transformIndexHtml(
            '/',
            fs.readFileSync(path.join(cfg.toilDir, 'index.html'), 'utf8'),
        );
        const ssrTemplates = await extractDevSsrTemplates(cfg, devShell);
        const server = await startDevServer({
            root,
            port,
            wasmFile: path.join(root, 'security.wasm'),
            vite: { host: '127.0.0.1', port: vitePort },
            ssrTemplates,
        });
        try {
            const origin = `http://127.0.0.1:${port}/`;
            await checkApp(origin);
            const first = await fetch(origin + 'devssr');
            expect(await first.text()).toContain('<h1>Dev SSR</h1>');
            const second = await fetch(origin + 'devssr');
            expect(first.headers.get('content-security-policy')).not.toBe(
                second.headers.get('content-security-policy'),
            );
            await browser.url(origin + 'devssr');
            await browser.waitUntil(async () => (await browser.$('h1').getText()) === 'Dev SSR');
            await browser.url(origin + 'other');
            await browser.waitUntil(async () => (await browser.$('h1').getText()) === 'Lazy route');
            write(
                'client/routes/other.tsx',
                'export default function Other(){return <h1>HMR updated</h1>;}',
            );
            await browser.waitUntil(
                async () => (await browser.$('h1').getText()) === 'HMR updated',
                { timeout: 15000 },
            );
        } finally {
            await browser.url('about:blank');
            await server.close();
            await vite.close();
        }
    }, 60000);
});

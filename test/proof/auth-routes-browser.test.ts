import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remote } from 'webdriverio';
import { scaffoldAuthApp } from './auth-fixture.js';

// Run after npm run build: this gate deliberately drives the shipped CLI.
describe.runIf(process.env.TOILJS_BROWSER_TESTS === '1')(
    'auth policy through CLI and browser cookies',
    () => {
        let root: string;
        let browser: Awaited<ReturnType<typeof remote>>;
        const children = new Set<ChildProcess>();
        const cli = resolve('build/cli/index.js');

        function command(args: string[]) {
            const child = spawn(process.execPath, [cli, ...args, '--root', root], {
                cwd: root,
                env: { ...process.env, TOIL_DEV_CHECK_DB_LIMITS: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            children.add(child);
            let output = '';
            child.stdout!.on('data', (data) => {
                output += String(data);
            });
            child.stderr!.on('data', (data) => {
                output += String(data);
            });
            return { child, output: () => output };
        }
        async function stop(child: ChildProcess) {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const closed = new Promise<void>((done) => child.once('close', () => done()));
            child.kill('SIGTERM');
            const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
            try {
                await closed;
            } finally {
                clearTimeout(timeout);
                children.delete(child);
            }
        }
        async function freePort() {
            const probe = createServer();
            await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
            const port = (probe.address() as { port: number }).port;
            await new Promise<void>((done) => probe.close(() => done()));
            return port;
        }
        async function start(mode: 'dev' | 'start', port: number) {
            const running = command([mode, '--port', String(port), '--host', '127.0.0.1']);
            const origin = `http://127.0.0.1:${port}`;
            await browser
                .waitUntil(
                    async () => {
                        if (running.child.exitCode !== null) throw new Error(running.output());
                        try {
                            return (await fetch(origin)).status === 200;
                        } catch {
                            return false;
                        }
                    },
                    { timeout: 30000, timeoutMsg: `CLI ${mode} did not start` },
                )
                .catch((error) => {
                    throw new Error(`${String(error)}\n${running.output()}`);
                });
            return { ...running, origin };
        }

        beforeAll(async () => {
            root = mkdtempSync(resolve('.toil-auth-browser-proof-'));
            scaffoldAuthApp(root, { google: false, twoFactorSetup: false, deleteAccount: false });
            writeFileSync(join(root, '.env'), 'AUTH_GOOGLE_CLIENT_ID=test-client\n');
            writeFileSync(join(root, '.env.secrets'), `AUTH_SESSION_SECRET=${'a'.repeat(64)}\n`, {
                mode: 0o600,
            });
            mkdirSync(join(root, 'client/routes'), { recursive: true });
            writeFileSync(
                join(root, 'client/routes/index.tsx'),
                `
import { useState } from 'react';
import { Auth, SERVER_KEM_PUBLIC_KEY } from 'toiljs/client';
export default function Proof() {
 const [status, setStatus] = useState('ready');
 async function signIn() {
  try {
   try { await Auth.register('browserproof', 'Strong-password-A1', 'browser@example.com'); }
   catch (error) { if (!(error instanceof Auth.UsernameTakenError)) throw error; }
   await Auth.login('browserproof', 'Strong-password-A1', { serverKemPublicKey: SERVER_KEM_PUBLIC_KEY });
   setStatus('signed in');
  } catch (error) { setStatus(String(error)); }
 }
 return <main><h1>Auth policy proof</h1><button onClick={signIn}>Sign in</button><output>{status}</output></main>;
}
`,
            );
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
        }, 30000);
        afterAll(async () => {
            if (browser) await browser.deleteSession();
            for (const child of children) await stop(child);
            if (root) rmSync(root, { recursive: true, force: true });
        });

        it('preserves live cookies on action 401s and refuses disabled routes in dev and start', async () => {
            for (const mode of ['dev', 'start'] as const) {
                if (mode === 'start') {
                    const build = command(['build']);
                    const code = await new Promise<number | null>((done) =>
                        build.child.once('close', done),
                    );
                    expect(code, build.output()).toBe(0);
                }
                const running = await start(mode, await freePort());
                try {
                    await browser.url(running.origin);
                    await browser.deleteCookies();
                    await browser.$('button').click();
                    await browser
                        .waitUntil(
                            async () => (await browser.$('output').getText()) === 'signed in',
                            {
                                timeout: 20000,
                            },
                        )
                        .catch(async (error) => {
                            throw new Error(
                                `${String(error)}: ${await browser.$('output').getText()}\n${running.output()}`,
                            );
                        });
                    const cookies = await browser.getCookies();
                    const session = cookies.find((cookie) => cookie.name === 'toil_sess');
                    const user = cookies.find((cookie) => cookie.name === 'toil_user');
                    expect(session?.httpOnly).toBe(true);
                    expect(user?.value).toBeTruthy();
                    const cookieHeader = cookies
                        .map((cookie) => `${cookie.name}=${cookie.value}`)
                        .join('; ');
                    for (const [path, body, status] of [
                        ['/proof/fail', [], 401],
                        ['/auth/confirm', [], 401],
                        ['/auth/google/start', [], 404],
                        ['/auth/google/login', [0, 0, 0, 0], 404],
                        ['/auth/2fa/setup', [1], 404],
                        ['/auth/2fa/setup', [2], 404],
                        ['/auth/2fa/setup/verify', [], 401],
                        ['/auth/delete', [], 404],
                    ] as const) {
                        // Check the actual HTTP response, including HttpOnly cookies.
                        const response = await fetch(running.origin + path, {
                            method: 'POST',
                            headers: { cookie: cookieHeader },
                            body: new Uint8Array(body),
                        });
                        expect(response.status).toBe(status);
                        if (path === '/proof/fail')
                            expect(response.headers.get('x-proof-action')).toBe('accepted');
                        expect(response.headers.getSetCookie()).toEqual([]);
                        if (status === 401)
                            expect(await response.text()).toBe('auth: request failed\n');
                        // Also let a real browser process the failure and then use its cookie jar.
                        const result = await browser.execute(
                            async (route, bytes) => {
                                const failed = await fetch(route, {
                                    method: 'POST',
                                    body: new Uint8Array(bytes),
                                });
                                return [
                                    failed.status,
                                    await failed.text(),
                                    (await fetch('/auth/me')).status,
                                ];
                            },
                            path,
                            [...body],
                        );
                        expect(result[0]).toBe(status);
                        if (status === 401) expect(result[1]).toBe('auth: request failed\n');
                        expect(result[2]).toBe(200);
                        const after = await browser.getCookies();
                        expect(after.find((cookie) => cookie.name === 'toil_sess')?.value).toBe(
                            session?.value,
                        );
                        expect(after.find((cookie) => cookie.name === 'toil_user')?.value).toBe(
                            user?.value,
                        );
                    }
                    // Enrollment probes above use four of the route's five
                    // allowed calls. Exercise removal once in the browser.
                    const removal = await browser.execute(async () => {
                        const response = await fetch('/auth/2fa/setup', {
                            method: 'POST',
                            body: new Uint8Array([0]),
                        });
                        return [response.status, (await fetch('/auth/me')).status];
                    });
                    expect(removal).toEqual([200, 200]);
                } finally {
                    await browser.url('about:blank');
                    await stop(running.child);
                }
            }
        }, 90000);
    },
);

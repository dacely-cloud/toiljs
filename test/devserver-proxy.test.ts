import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { expect, it } from 'vitest';
import { startDevServer, type RunningDevServer } from '../src/devserver/server';

/** The client connects to loopback while retaining its public Host header. */
interface ProxyReply {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly body: Buffer;
}

it('preserves the browser Host, popup policy, cookies, redirects and binary bodies through Vite', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-proxy-test-'));
    const payload = Buffer.from([0, 255, 128, 13, 10, 42]);
    const upstream = createServer((incoming, response) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
            response.setHeader('x-received-host', incoming.headers.host ?? '');
            response.setHeader('x-received-method', incoming.method ?? '');
            response.setHeader('x-received-cookie', incoming.headers.cookie ?? '');
            response.setHeader('x-received-encoding', incoming.headers['accept-encoding'] ?? '');
            response.setHeader('set-cookie', ['first=1; Path=/', 'second=2; Path=/']);
            response.setHeader('content-security-policy', "default-src 'self'");
            response.setHeader(
                'cross-origin-opener-policy',
                incoming.headers.host === 'localhost:3000'
                    ? 'same-origin-allow-popups'
                    : 'same-origin',
            );
            if (incoming.url === '/redirect') {
                response.writeHead(302, { location: '/destination' }).end();
            } else response.end(incoming.method === 'POST' ? Buffer.concat(chunks) : payload);
        });
    });
    const reservation = net.createServer();
    let front: RunningDevServer | undefined;
    try {
        await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
        await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
        const upstreamPort = (upstream.address() as net.AddressInfo).port;
        const port = (reservation.address() as net.AddressInfo).port;
        await new Promise<void>((resolve) => reservation.close(() => resolve()));
        front = await startDevServer({
            root,
            port,
            wasmFile: path.join(root, 'absent.wasm'),
            vite: { host: '127.0.0.1', port: upstreamPort },
        });
        const query = (
            method: string,
            pathname = '/',
            host = 'localhost:3000',
        ): Promise<ProxyReply> =>
            new Promise((resolve, reject) => {
                const outgoing = request(
                    {
                        hostname: '127.0.0.1',
                        port,
                        method,
                        path: pathname,
                        headers: { host, cookie: 'session=original', 'accept-encoding': 'gzip' },
                    },
                    (incoming) => {
                        const chunks: Buffer[] = [];
                        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
                        incoming.on('error', reject);
                        incoming.on('end', () =>
                            resolve({
                                status: incoming.statusCode ?? 0,
                                headers: incoming.headers,
                                body: Buffer.concat(chunks),
                            }),
                        );
                    },
                );
                outgoing.on('error', reject);
                outgoing.end(method === 'POST' ? payload : undefined);
            });
        const get = await query('GET');
        expect(get.status).toBe(200);
        expect(get.headers['x-received-host']).toBe('localhost:3000');
        expect(get.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
        expect(get.headers['content-security-policy']).toBe("default-src 'self'");
        expect(get.headers['x-received-cookie']).toBe('session=original');
        expect(get.headers['x-received-encoding']).toBe('identity');
        expect(get.headers['set-cookie']).toEqual(['first=1; Path=/', 'second=2; Path=/']);
        expect(get.body).toEqual(payload);
        expect((await query('GET', '/', 'example.org')).headers['cross-origin-opener-policy']).toBe(
            'same-origin',
        );
        expect((await query('POST')).body).toEqual(payload);
        const head = await query('HEAD');
        expect(head.headers['x-received-method']).toBe('GET');
        expect(head.body.length).toBe(0);
        const redirect = await query('GET', '/redirect');
        expect(redirect.status).toBe(302);
        expect(redirect.headers.location).toBe('/destination');
    } finally {
        await front?.close();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        if (reservation.listening)
            await new Promise<void>((resolve) => reservation.close(() => resolve()));
        fs.rmSync(root, { recursive: true, force: true });
    }
}, 30000);

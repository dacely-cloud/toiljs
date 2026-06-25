/**
 * Dev STREAM emulation end-to-end (Phase 4). Compiles real `@stream` fixtures with the LOCAL toilscript
 * (`--targetMode hot`), then drives `DevStreamBox` + `StreamDevHost` and asserts the dev runtime mirrors
 * the production edge (`toil-backend` `src/wasm/stream`) BYTE-FOR-BYTE: the `@message` ring bridge
 * (echo / reject / empty), the `@connect` info-block bridge (path-based accept/reject + egress clear),
 * and the session driver (accept / dispatch / trap-close / lifecycle). The dev mirror of toil-backend's
 * message_bridge + @connect + hostile-isolation tests.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@dacely/hyper-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { matchStreamRoute, parseStreamCatalog } from '../src/devserver/stream/catalog.js';
import { wireStreams } from '../src/devserver/stream/wire.js';
import { DevStreamBox } from '../src/devserver/stream/index.js';
import { StreamDevHost } from '../src/devserver/stream/manager.js';
import {
    StreamRouter,
    type StreamUpgradeContext,
    type StreamWs,
} from '../src/devserver/stream/router.js';
import { StreamWsSession, type StreamWsTransport } from '../src/devserver/stream/ws.js';

const here = dirname(fileURLToPath(import.meta.url));
// The LOCAL toilscript build (the @message + @connect bridge codegen); the published dep predates it.
const LOCAL_TOILSCRIPT_BIN = join(here, '..', '..', 'toilscript', 'bin', 'toilscript.js');

let tmp: string;
let ECHO_PATH: string;
let GATE_PATH: string;
let TRAP_PATH: string;
let ECHO: Buffer;
let GATE: Buffer;

function compile(srcName: string): { path: string; wasm: Buffer } {
    const src = join(here, 'fixtures', srcName);
    const out = join(tmp, srcName.replace(/\.ts$/, '.wasm'));
    const r = spawnSync(
        'node',
        [LOCAL_TOILSCRIPT_BIN, src, '-o', out, '--targetMode', 'hot', '--runtime', 'stub'],
        { encoding: 'utf8' },
    );
    if (r.status !== 0) {
        throw new Error(`toilscript compile ${srcName} failed (${String(r.status)}):\n${r.stderr}${r.stdout}`);
    }
    return { path: out, wasm: readFileSync(out) };
}

beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'toiljs-stream-'));
    const echo = compile('stream-echo.ts');
    ECHO_PATH = echo.path;
    ECHO = echo.wasm;
    const gate = compile('stream-gate.ts');
    GATE_PATH = gate.path;
    GATE = gate.wasm;
    TRAP_PATH = compile('stream-trap.ts').path;
});

afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('dev stream box: the @message ring bridge', () => {
    const id = 0x0000_0007_0000_0005n;

    it('loads a hot stream artifact with the ring runtime', () => {
        expect(DevStreamBox.load(ECHO).hasRings).toBe(true);
    });

    it('echoes / rejects / empties through the ring, persisting state across events', () => {
        const box = DevStreamBox.load(ECHO);
        expect(box.onConnect(id, 'localhost', '/').kind).toBe('accept'); // echo declares no @connect
        expect(box.onMessage(id, Buffer.from('hello'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('hello')],
        });
        expect(box.onMessage(id, Buffer.from('second frame'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('second frame')],
        });
        expect(box.onMessage(id, Buffer.from('Xdrop'))).toEqual({ kind: 'reject', code: 0x0210 });
        expect(box.onMessage(id, Buffer.from(''))).toEqual({ kind: 'reply', frames: [] });
    });

    it('rejects a non-stream artifact (fails closed)', () => {
        expect(() => DevStreamBox.load(Buffer.from('\0asm\x01\0\0\0', 'binary'))).toThrow();
    });
});

describe('dev stream box: the @connect info-block bridge', () => {
    const id = 0x11n;

    it('reads the connect path and rejects /blocked while accepting others', () => {
        const box = DevStreamBox.load(GATE);
        expect(box.hasConnectBridge).toBe(true);
        expect(box.onConnect(id, 'acme.toil', '/blocked')).toEqual({ kind: 'reject', code: 0x0211 });

        const ok = DevStreamBox.load(GATE);
        expect(ok.onConnect(id, 'acme.toil', '/room/42')).toEqual({ kind: 'accept' });
        // An accepted connection is usable: its @message echoes.
        expect(ok.onMessage(id, Buffer.from('hi'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('hi')],
        });
    });

    it('clears @connect-staged egress so the first @message reply is clean', () => {
        const box = DevStreamBox.load(GATE);
        // /greet stages "GHI" during @connect; the host clears it on accept.
        expect(box.onConnect(id, 'acme.toil', '/greet')).toEqual({ kind: 'accept' });
        // The first @message must see ONLY its own reply, never the stale "GHI".
        expect(box.onMessage(id, Buffer.from('hi'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('hi')],
        });
    });
});

describe('dev stream session driver (StreamDevHost)', () => {
    it('accepts, dispatches, and closes - mirroring StreamWorker', () => {
        const host = new StreamDevHost(ECHO_PATH);
        expect(host.acceptUpgrade('c1', 'acme.toil', '/').kind).toBe('accepted');
        expect(host.activeConnections).toBe(1);
        expect(host.dispatch('c1', Buffer.from('one'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('one')],
        });
        // A guest reject -> close with the 0x02xx code.
        expect(host.dispatch('c1', Buffer.from('Xstop'))).toEqual({ kind: 'close', code: 0x0210 });
        // A frame for an unknown connection.
        expect(host.dispatch('ghost', Buffer.from('x'))).toEqual({ kind: 'noConnection' });
        host.close('c1');
        expect(host.activeConnections).toBe(0);
    });

    it('honors a @connect reject at the upgrade (no box registered)', () => {
        const host = new StreamDevHost(GATE_PATH);
        expect(host.acceptUpgrade('c1', 'acme.toil', '/blocked')).toEqual({
            kind: 'rejected',
            code: 0x0211,
        });
        expect(host.activeConnections).toBe(0);
        expect(host.acceptUpgrade('c2', 'acme.toil', '/ok').kind).toBe('accepted');
        expect(host.dispatch('c2', Buffer.from('hi'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('hi')],
        });
    });

    it('trap-closes a hostile @message and discards only its box', () => {
        const host = new StreamDevHost(TRAP_PATH);
        host.acceptUpgrade('h1', 'acme.toil', '/');
        host.acceptUpgrade('h2', 'acme.toil', '/');
        expect(host.activeConnections).toBe(2);
        // h1's @message TRAPS -> STREAM_HOOK_TRAPPED close, its box discarded; h2 is untouched.
        expect(host.dispatch('h1', Buffer.from('boom'))).toEqual({ kind: 'close', code: 0x0200 });
        expect(host.has('h1')).toBe(false);
        expect(host.has('h2')).toBe(true);
        expect(host.activeConnections).toBe(1);
    });

    it('throws on a duplicate open', () => {
        const host = new StreamDevHost(ECHO_PATH);
        host.acceptUpgrade('c1', 'acme.toil', '/');
        expect(() => host.acceptUpgrade('c1', 'acme.toil', '/')).toThrow();
    });
});

describe('dev stream WS session adapter (StreamWsSession)', () => {
    function makeTransport(): { sent: Buffer[]; closed: number[]; t: StreamWsTransport } {
        const sent: Buffer[] = [];
        const closed: number[] = [];
        return {
            sent,
            closed,
            t: { send: (f: Buffer) => sent.push(f), close: (c: number) => closed.push(c) },
        };
    }

    it('accepts, echoes a frame back, and tears down', () => {
        const host = new StreamDevHost(ECHO_PATH);
        const { sent, closed, t } = makeTransport();
        const s = new StreamWsSession(host, 'ws1', 'acme.toil', '/', t);
        expect(s.onOpen()).toBe(true);
        expect(s.isOpen).toBe(true);
        s.onMessage(Buffer.from('hi'));
        expect(sent).toEqual([Buffer.from('hi')]);
        expect(closed).toEqual([]);
        s.onClose();
        expect(host.activeConnections).toBe(0);
    });

    it('closes the socket with the code on a guest reject, then fires @close on socket close', () => {
        const host = new StreamDevHost(ECHO_PATH);
        const { closed, t } = makeTransport();
        const s = new StreamWsSession(host, 'ws1', 'acme.toil', '/', t);
        s.onOpen();
        s.onMessage(Buffer.from('Xstop')); // guest reject -> close 0x0210
        expect(closed).toEqual([0x0210]);
        expect(s.isOpen).toBe(false);
        s.onClose();
        expect(host.activeConnections).toBe(0);
    });

    it('closes a @connect-rejected upgrade without holding a box', () => {
        const host = new StreamDevHost(GATE_PATH);
        const { closed, t } = makeTransport();
        const s = new StreamWsSession(host, 'ws1', 'acme.toil', '/blocked', t);
        expect(s.onOpen()).toBe(false);
        expect(closed).toEqual([0x0211]);
        expect(host.activeConnections).toBe(0);
    });
});

describe('dev stream catalog (toilstream.catalog route table, doc 08 3.1/4.2)', () => {
    it('parses the @stream route table and matches routes (query stripped)', () => {
        const cat = parseStreamCatalog(ECHO);
        expect(cat.size).toBe(1);
        const def = [...cat.values()][0];
        expect(def.route.length).toBeGreaterThan(0);
        expect(def.hooks.message).toBe(true);
        expect(def.scope).toBe('regional'); // declared_scope default
        expect(def.messageMode).toBe('raw'); // the raw @message bridge
        // matchRoute (4.2): exact match, query stripped; a non-route misses (-> proxied to Vite).
        expect(matchStreamRoute(cat, def.route)).toBe(def);
        expect(matchStreamRoute(cat, `${def.route}?x=1`)).toBe(def);
        expect(matchStreamRoute(cat, '/definitely-not-a-stream')).toBeNull();
    });
});

/** A minimal hyper-express `Websocket` mock for the router (records send/close, replays events). */
class MockWs implements StreamWs {
    readonly sent: Buffer[] = [];
    readonly closed: number[] = [];
    private msgCb?: (m: Buffer, b: boolean) => void;
    private closeCb?: () => void;
    send(d: Buffer, _isBinary: boolean): void {
        this.sent.push(d);
    }
    close(c: number): void {
        this.closed.push(c);
    }
    on(event: 'message', cb: (m: Buffer, b: boolean) => void): void;
    on(event: 'close', cb: () => void): void;
    on(event: 'message' | 'close', cb: ((m: Buffer, b: boolean) => void) | (() => void)): void {
        if (event === 'message') this.msgCb = cb as (m: Buffer, b: boolean) => void;
        else this.closeCb = cb as () => void;
    }
    emitMessage(m: Buffer): void {
        this.msgCb?.(m, true);
    }
    emitClose(): void {
        this.closeCb?.();
    }
}

describe('dev stream router (doc 08 4.1/4.2)', () => {
    it('matches @stream routes and bridges a socket to a resident box', () => {
        const router = new StreamRouter(ECHO_PATH);
        const route = [...parseStreamCatalog(ECHO).keys()][0];
        expect(router.matchRoute(route)).not.toBeNull();
        expect(router.matchRoute(`${route}?x=1`)).not.toBeNull(); // query stripped
        expect(router.matchRoute('/not-a-stream')).toBeNull(); // -> proxied to Vite

        const ws = new MockWs();
        const ctx: StreamUpgradeContext = { kind: 'stream', route, url: route, authority: 'acme.toil' };
        router.onUpgrade(ws, ctx);
        expect(router.activeConnections).toBe(1);
        ws.emitMessage(Buffer.from('hi'));
        expect(ws.sent).toEqual([Buffer.from('hi')]); // @message echoed back over the socket
        ws.emitClose();
        expect(router.activeConnections).toBe(0); // @close fired + box dropped
    });

    it('closes the socket with the code on a @connect reject', () => {
        const router = new StreamRouter(GATE_PATH);
        const route = [...parseStreamCatalog(GATE).keys()][0];
        const ws = new MockWs();
        // The gate rejects path "/blocked"; the upgrade's url carries the connect path.
        router.onUpgrade(ws, { kind: 'stream', route, url: '/blocked', authority: 'acme.toil' });
        expect(ws.closed).toEqual([0x0211]);
        expect(router.activeConnections).toBe(0); // rejected -> no resident box
    });
});

describe('dev stream LIVE round-trip (wireStreams over a real WebSocket)', () => {
    it('echoes a binary frame end-to-end through app.upgrade + app.ws', async () => {
        const router = new StreamRouter(ECHO_PATH);
        const route = [...parseStreamCatalog(ECHO).keys()][0];
        const app = new Server();
        // A dummy Vite target: a @stream-route upgrade never touches it (it goes to the StreamRouter).
        wireStreams(app, { host: '127.0.0.1', port: 65535 }, router);

        const PORT = 49317;
        await app.listen(PORT);
        try {
            const echoed = await new Promise<Buffer>((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${String(PORT)}${route}`);
                ws.binaryType = 'arraybuffer';
                const timer = setTimeout(() => {
                    reject(new Error('no echo within 3s'));
                }, 3000);
                ws.onopen = (): void => {
                    ws.send(new Uint8Array([0x68, 0x69])); // "hi"
                };
                ws.onmessage = (ev: MessageEvent): void => {
                    clearTimeout(timer);
                    resolve(Buffer.from(ev.data as ArrayBuffer));
                    ws.close();
                };
                ws.onerror = (): void => {
                    clearTimeout(timer);
                    reject(new Error('websocket error'));
                };
            });
            expect(echoed).toEqual(Buffer.from('hi'));
        } finally {
            app.close();
        }
    });
});

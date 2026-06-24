/**
 * Dev STREAM emulation end-to-end (Phase 4). Compiles a real `@stream` fixture to `release-stream.wasm`
 * with the LOCAL toilscript (`--targetMode hot`), then drives `DevStreamBox` against it and asserts the
 * raw `@message` ring bridge - echo / reject / empty - matches the production edge byte-for-byte, with
 * state persisting across events on the single resident box. This is the dev-side mirror of
 * toil-backend's `message_bridge_reply_reject_empty_roundtrip`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DevStreamBox } from '../src/devserver/stream/index.js';
import { StreamDevHost } from '../src/devserver/stream/manager.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = join(here, 'fixtures', 'stream-echo.ts');
// The LOCAL toilscript build (the @message-bridge codegen); the published dep predates it.
const LOCAL_TOILSCRIPT_BIN = join(here, '..', '..', 'toilscript', 'bin', 'toilscript.js');

let WASM: Buffer;
let WASM_PATH: string;
let tmp: string;

beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'toiljs-stream-'));
    WASM_PATH = join(tmp, 'release-stream.wasm');
    const r = spawnSync(
        'node',
        [LOCAL_TOILSCRIPT_BIN, FIXTURE_SRC, '-o', WASM_PATH, '--targetMode', 'hot', '--runtime', 'stub'],
        { encoding: 'utf8' },
    );
    if (r.status !== 0) {
        throw new Error(`toilscript compile failed (${String(r.status)}):\n${r.stderr}${r.stdout}`);
    }
    WASM = readFileSync(WASM_PATH);
});

afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('dev stream box: the @message ring bridge', () => {
    const id = 0x0000_0007_0000_0005n;

    it('loads a hot stream artifact with the ring runtime', () => {
        const box = DevStreamBox.load(WASM);
        expect(box.hasRings).toBe(true);
    });

    it('echoes / rejects / empties through the ring, persisting state across events', () => {
        const box = DevStreamBox.load(WASM);

        // @connect is absent on the echo class -> a no-op success (non-negative).
        expect(box.onConnect(id) >= 0n).toBe(true);

        // "hello" echoes back through the egress ring.
        expect(box.onMessage(id, Buffer.from('hello'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('hello')],
        });

        // A second, longer message echoes again on the SAME resident box (the drained-reset works).
        expect(box.onMessage(id, Buffer.from('second frame'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('second frame')],
        });

        // An 'X'-prefixed frame rejects with 0x0210 (the negative packed-i64 bridge).
        expect(box.onMessage(id, Buffer.from('Xdrop'))).toEqual({ kind: 'reject', code: 0x0210 });

        // An empty frame stages nothing -> zero reply frames.
        expect(box.onMessage(id, Buffer.from(''))).toEqual({ kind: 'reply', frames: [] });
    });

    it('rejects a non-stream artifact (fails closed)', () => {
        const notStream = Buffer.from('\0asm\x01\0\0\0', 'binary');
        expect(() => DevStreamBox.load(notStream)).toThrow();
    });
});

describe('dev stream connection manager (StreamDevHost)', () => {
    it('drives independent per-connection resident boxes through their lifecycle', () => {
        const host = new StreamDevHost(WASM_PATH);

        // Two independent connections, each a fresh resident box with its own host stream id.
        const id1 = host.open('c1');
        const id2 = host.open('c2');
        expect(id1).not.toBe(id2);
        expect(id1).not.toBe(0n);
        expect(host.activeConnections).toBe(2);

        // Each connection's @message echoes independently.
        expect(host.message('c1', Buffer.from('one'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('one')],
        });
        expect(host.message('c2', Buffer.from('two'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('two')],
        });

        // A reject on one connection does not disturb the other.
        expect(host.message('c1', Buffer.from('Xstop'))).toEqual({ kind: 'reject', code: 0x0210 });
        expect(host.message('c2', Buffer.from('again'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('again')],
        });

        // Close drops one box; the neighbour stays live.
        host.close('c1');
        expect(host.has('c1')).toBe(false);
        expect(host.activeConnections).toBe(1);
        expect(host.message('c2', Buffer.from('still'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('still')],
        });

        // Re-opening a freed id works; disconnect drops the last box.
        host.open('c1');
        expect(host.activeConnections).toBe(2);
        host.disconnect('c1');
        host.disconnect('c2');
        expect(host.activeConnections).toBe(0);
    });

    it('throws on a duplicate open and on a message for an unknown connection', () => {
        const host = new StreamDevHost(WASM_PATH);
        host.open('c1');
        expect(() => host.open('c1')).toThrow();
        expect(() => host.message('ghost', Buffer.from('x'))).toThrow();
    });
});

/**
 * Dev STREAM emulation end-to-end (Phase 4). Compiles real `@stream` fixtures with the LOCAL toilscript
 * (`--targetMode hot`), then drives `DevStreamBox` + `StreamDevHost` and asserts the dev runtime mirrors
 * the production edge (`toil-backend` `src/wasm/stream`) BYTE-FOR-BYTE: the `@message` ring bridge
 * (echo / reject / empty), the `@connect` info-block bridge (path-based accept/reject + egress clear),
 * and the session driver (accept / dispatch / trap-close / lifecycle). The dev mirror of toil-backend's
 * message_bridge + @connect + hostile-isolation tests.
 *
 * Also covers MULTI-`@stream` runtime selection: an app with several `@stream` classes compiles to ONE
 * artifact whose `toilstream.catalog` gives each route its own `stream_index`, and the dev host must
 * drive each connection to the box its route names (`stream_set_active`), not always to handler 0. The
 * two-box program is compiled the way `toiljs` really invokes the compiler (EVERY tier file as a
 * positional entry, see `src/compiler/index.ts` `toilscriptPass`), and a pre-selection artifact (built
 * by the compiler before `stream_set_active` existed) is loaded to pin the back-compat path.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@dacely/hyper-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeStreamClient } from '../src/client/stream/client.js';
import {
    matchStreamRoute,
    parseStreamCatalog,
    type StreamDef,
} from '../src/devserver/stream/catalog.js';
import { buildStreamImports, freshStreamBoxState } from '../src/devserver/stream/host.js';
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
// The toilscript build with the @message + @connect bridge codegen (it ships in the dep now).
// Resolved from node_modules so this works both locally (the symlinked repo) and in CI (the npm
// dep), not from a sibling checkout that CI does not have.
const LOCAL_TOILSCRIPT_BIN = join(here, '..', 'node_modules', 'toilscript', 'bin', 'toilscript.js');

let tmp: string;
let ECHO_PATH: string;
let GATE_PATH: string;
let TRAP_PATH: string;
let ECHO: Buffer;
let GATE: Buffer;
let TYPED: Buffer;
/** The two-`@stream` program (stream-alpha.ts + stream-beta.ts), compiled as ONE unit. */
let TWO_PATH: string;
let TWO: Buffer;
/** An artifact built by the compiler BEFORE `stream_set_active` existed (committed fixture). */
const PREPATCH_PATH = join(here, 'fixtures', 'stream-echo-prepatch.wasm');
let PREPATCH: Buffer;

/**
 * Launch one toilscript compilation as a NON-BLOCKING child process and resolve with its artifact.
 *
 * The hook used to call `spawnSync` five times back to back, so its wall time was the SUM of five
 * node+compiler launches and the worker thread could not even observe a timeout until all five had
 * already run. Alone that fits vitest's default 10s hook budget (~4s), but under the full suite's
 * worker contention the same serial hook measured 12.5-15.8s and the whole file was reported as
 * `Hook timed out in 10000ms` with all 29 tests skipped. Every program reads only committed fixtures
 * and writes its own artifact under `tmp`, so there is no shared state to serialize: launched together
 * the hook costs the SLOWEST single compile instead of the sum of five.
 *
 * A MULTI-FILE `@stream` program is invoked the way `toiljs` really invokes the compiler: EVERY tier
 * file is a positional entry (see `src/compiler/index.ts` `toilscriptPass`: `const args = [...files,
 * '--target', 'release']`). Passing only one entry (what `compile` below does for a single-class
 * fixture) makes the other `@stream` class a plain import, and then the once-per-program selection
 * preamble + the second catalog row do not surface - a misleading failure, not a missing feature.
 */
function compileProgram(
    outName: string,
    srcNames: string[],
): Promise<{ path: string; wasm: Buffer }> {
    const srcs = srcNames.map((n) => join(here, 'fixtures', n));
    const out = join(tmp, outName);
    return new Promise((resolve, reject) => {
        const child = spawn('node', [
            LOCAL_TOILSCRIPT_BIN,
            ...srcs,
            '-o',
            out,
            '--targetMode',
            'hot',
            '--runtime',
            'stub',
        ]);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (status) => {
            if (status !== 0) {
                reject(
                    new Error(
                        `toilscript compile ${srcNames.join(' + ')} failed (${String(status)}):\n${stderr}${stdout}`,
                    ),
                );
                return;
            }
            resolve({ path: out, wasm: readFileSync(out) });
        });
    });
}

/** Compile a single-class `@stream` fixture; the artifact name follows the source, as before. */
function compile(srcName: string): Promise<{ path: string; wasm: Buffer }> {
    return compileProgram(srcName.replace(/\.ts$/, '.wasm'), [srcName]);
}

/** The wasm export names of an artifact, read straight off the module (no toiljs code involved). */
function exportedNames(wasm: Buffer): string[] {
    return WebAssembly.Module.exports(new WebAssembly.Module(new Uint8Array(wasm))).map(
        (e) => e.name,
    );
}

beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'toiljs-stream-'));
    // An artifact from the compiler BEFORE stream_set_active existed, committed as a fixture so the
    // back-compat case does not depend on a scratchpad bundle backup. Read up front, while the
    // compilations below are in flight: it shares nothing with them.
    PREPATCH = readFileSync(PREPATCH_PATH);
    // The five programs share NOTHING but the temp dir (each writes its own artifact, each reads only
    // committed fixtures), so they compile CONCURRENTLY. Run serially the hook cost the SUM of five
    // node+compiler launches, which is what overran vitest's default 10s hook budget once the two-file
    // alpha+beta program was added; concurrently it costs the SLOWEST single compile.
    const [echo, gate, trap, typed, two] = await Promise.all([
        compile('stream-echo.ts'),
        compile('stream-gate.ts'),
        compile('stream-trap.ts'),
        compile('stream-typed.ts'),
        // Two @stream classes in ONE program: both files are positional entries, as the real build does.
        compileProgram('release-stream-two.wasm', ['stream-alpha.ts', 'stream-beta.ts']),
    ]);
    ECHO_PATH = echo.path;
    ECHO = echo.wasm;
    GATE_PATH = gate.path;
    GATE = gate.wasm;
    TRAP_PATH = trap.path;
    TYPED = typed.wasm;
    TWO_PATH = two.path;
    TWO = two.wasm;
});

afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('dev stream box: typed @data @message decode (doc 03 2.5)', () => {
    it('decodes a guest-seeded @data payload at runtime and replies with the decoded field', () => {
        // Seed a real ChatMsg.encode() from a raw instance (deterministic), so the host feeds VALID
        // @data bytes without hand-crafting the wire format.
        const ref: { memory: WebAssembly.Memory | null } = { memory: null };
        const state = freshStreamBoxState();
        const seedInst = new WebAssembly.Instance(
            new WebAssembly.Module(new Uint8Array(TYPED)),
            buildStreamImports(ref, state),
        );
        const sx = seedInst.exports as unknown as {
            memory: WebAssembly.Memory;
            seedHi: () => void;
            seedOffset: () => number;
            seedLength: () => number;
        };
        ref.memory = sx.memory;
        sx.seedHi();
        const off = sx.seedOffset() >>> 0;
        const len = sx.seedLength() >>> 0;
        expect(len).toBeGreaterThan(0);
        const payload = Buffer.from(new Uint8Array(sx.memory.buffer, off, len));

        // Drive the typed @message: the guest DECODES ChatMsg{text:"hi"} and replies with text.length.
        const box = DevStreamBox.load(TYPED);
        const tid = 0x0000_0000_0000_0011n;
        expect(box.onConnect(tid, 'localhost', '/').kind).toBe('accept');
        const out = box.onMessage(tid, payload);
        expect(out.kind).toBe('reply');
        if (out.kind === 'reply') {
            expect(out.frames.length).toBe(1);
            expect(out.frames[0][0]).toBe(2); // decoded "hi" -> text.length 2
        }
    });
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
        expect(box.onConnect(id, 'acme.toil', '/blocked')).toEqual({
            kind: 'reject',
            code: 0x0211,
            initialEgress: [],
        });

        const ok = DevStreamBox.load(GATE);
        expect(ok.onConnect(id, 'acme.toil', '/room/42')).toEqual({
            kind: 'accept',
            initialEgress: [],
        });
        // An accepted connection is usable: its @message echoes.
        expect(ok.onMessage(id, Buffer.from('hi'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('hi')],
        });
    });

    it('returns @connect-staged egress and keeps the first @message reply clean', () => {
        const box = DevStreamBox.load(GATE);
        // /greet stages "GHI" during @connect; the host returns it as initial egress.
        expect(box.onConnect(id, 'acme.toil', '/greet')).toEqual({
            kind: 'accept',
            initialEgress: [Buffer.from('GHI')],
        });
        // The first @message must see ONLY its own reply, never the drained initial "GHI".
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
            initialEgress: [],
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

    it('returns initial egress from @connect while keeping dispatch clean', () => {
        const host = new StreamDevHost(GATE_PATH);
        expect(host.acceptUpgrade('c1', 'acme.toil', '/greet')).toMatchObject({
            kind: 'accepted',
            initialEgress: [Buffer.from('GHI')],
        });
        expect(host.dispatch('c1', Buffer.from('hi'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('hi')],
        });
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

    it('sends @connect initial egress on open', () => {
        const host = new StreamDevHost(GATE_PATH);
        const { sent, closed, t } = makeTransport();
        const s = new StreamWsSession(host, 'ws1', 'acme.toil', '/greet', t);
        expect(s.onOpen()).toBe(true);
        expect(s.isOpen).toBe(true);
        expect(sent).toEqual([Buffer.from('GHI')]);
        expect(closed).toEqual([]);
        s.onMessage(Buffer.from('hi'));
        expect(sent).toEqual([Buffer.from('GHI'), Buffer.from('hi')]);
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
        const ctx: StreamUpgradeContext = {
            kind: 'stream',
            route,
            url: route,
            authority: 'acme.toil',
        };
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

/**
 * MULTI-`@stream` runtime selection (cases `devhost-two-routes`, `devhost-old-artifact-compat`).
 *
 * An app with several `@stream` classes compiles to ONE artifact whose `toilstream.catalog` gives each
 * route its own `stream_index`; every connection must reach the box its route names, not always
 * handler 0. The expected reply bytes come from the two fixtures' OWN hook bodies (`stream-alpha.ts`
 * prefixes 0x41 'A', `stream-beta.ts` prefixes 0x42 'B'), never from the host code under test, so a
 * host that always selects box 0 cannot satisfy both assertions at once.
 */
describe('dev stream multi-box selection (two @stream classes in one artifact)', () => {
    const IN = Buffer.from('ping');

    /** The catalog entries of the two-file program, looked up by the declared `@stream` name. */
    function twoBoxes(): { alpha: StreamDef; beta: StreamDef } {
        const defs = [...parseStreamCatalog(TWO).values()];
        const alpha = defs.find((d) => d.name === 'alpha');
        const beta = defs.find((d) => d.name === 'beta');
        if (alpha === undefined || beta === undefined) {
            throw new Error(
                `two-box artifact must catalog alpha + beta, got: ${JSON.stringify(defs.map((d) => d.name))}`,
            );
        }
        return { alpha, beta };
    }

    it('devhost-two-routes: catalog records both routes with distinct stream_index values', () => {
        const { alpha, beta } = twoBoxes();
        expect(parseStreamCatalog(TWO).size).toBe(2);
        expect(alpha.route).toBe('/alpha');
        expect(beta.route).toBe('/beta');
        // The premise of every case below: the two routes really name DIFFERENT boxes. If both were
        // 0 the selection assertions would pass for the wrong reason.
        expect(alpha.streamIndex).not.toBe(beta.streamIndex);
        expect(exportedNames(TWO)).toContain('stream_set_active');
    });

    it('devhost-two-routes: routes each connection to its own box through the real StreamRouter', () => {
        const { alpha, beta } = twoBoxes();
        const router = new StreamRouter(TWO_PATH);
        const wsA = new MockWs();
        const wsB = new MockWs();
        // The upgrade context exactly as `wireStreams` stamps it: the matched route + its catalog index.
        router.onUpgrade(wsA, {
            kind: 'stream',
            route: alpha.route,
            url: alpha.route,
            authority: 'acme.toil',
            streamIndex: alpha.streamIndex,
        });
        router.onUpgrade(wsB, {
            kind: 'stream',
            route: beta.route,
            url: beta.route,
            authority: 'acme.toil',
            streamIndex: beta.streamIndex,
        });
        expect(router.activeConnections).toBe(2);
        wsA.emitMessage(IN);
        wsB.emitMessage(IN);
        expect(wsA.sent).toEqual([Buffer.from(`A${IN.toString()}`)]);
        expect(wsB.sent).toEqual([Buffer.from(`B${IN.toString()}`)]);
        // The selection is re-applied on EVERY event, not just at connect: a second frame on each
        // connection must still be answered by that connection's own box.
        wsA.emitMessage(IN);
        wsB.emitMessage(IN);
        expect(wsA.sent).toEqual([
            Buffer.from(`A${IN.toString()}`),
            Buffer.from(`A${IN.toString()}`),
        ]);
        expect(wsB.sent).toEqual([
            Buffer.from(`B${IN.toString()}`),
            Buffer.from(`B${IN.toString()}`),
        ]);
    });

    it('devhost-two-routes: the router resolves the box from the catalog when the context omits streamIndex', () => {
        const { alpha, beta } = twoBoxes();
        const router = new StreamRouter(TWO_PATH);
        const wsA = new MockWs();
        const wsB = new MockWs();
        // A hand-built context carries no streamIndex: `onUpgrade` must re-resolve it from the catalog
        // (the `ctx.streamIndex ?? this.matchRoute(path)?.streamIndex ?? 0` branch).
        router.onUpgrade(wsA, {
            kind: 'stream',
            route: alpha.route,
            url: alpha.route,
            authority: 'acme.toil',
        });
        router.onUpgrade(wsB, {
            kind: 'stream',
            route: beta.route,
            url: beta.route,
            authority: 'acme.toil',
        });
        wsA.emitMessage(IN);
        wsB.emitMessage(IN);
        expect(wsA.sent).toEqual([Buffer.from(`A${IN.toString()}`)]);
        expect(wsB.sent).toEqual([Buffer.from(`B${IN.toString()}`)]);
    });

    it('devhost-two-routes known-bad control: forcing stream_index 0 makes the /beta route answer as Alpha', () => {
        const { beta } = twoBoxes();
        const router = new StreamRouter(TWO_PATH);
        const ws = new MockWs();
        // The pre-plumbing behavior: every connection landed on handler 0 whatever its route.
        router.onUpgrade(ws, {
            kind: 'stream',
            route: beta.route,
            url: beta.route,
            authority: 'acme.toil',
            streamIndex: 0,
        });
        ws.emitMessage(IN);
        // If this DIDN'T happen the artifact would hold only one box, and the passing selection case
        // above would prove nothing.
        expect(ws.sent).toEqual([Buffer.from(`A${IN.toString()}`)]);
    });

    it('devhost-two-routes boundary: an out-of-range selection is a no-op, never a trap', () => {
        const router = new StreamRouter(TWO_PATH);
        const ws = new MockWs();
        router.onUpgrade(ws, {
            kind: 'stream',
            route: '/beta',
            url: '/beta',
            authority: 'acme.toil',
            streamIndex: 7, // this artifact registers exactly two boxes: 0 and 1
        });
        expect(router.activeConnections).toBe(1); // @connect itself is still accepted
        expect(() => ws.emitMessage(IN)).not.toThrow();
        // The guest bounds-checks the index and runs NO handler, so the dispatch succeeds with zero
        // egress frames rather than trapping or closing.
        expect(ws.sent).toEqual([]);
        expect(ws.closed).toEqual([]);
    });

    it('devhost-two-routes live: wireStreams stamps each route own index over a real WebSocket', async () => {
        // The full production chain, no mocks: a real upgrade -> `wireStreams` (which stamps
        // `streamIndex: def.streamIndex`) -> StreamRouter -> StreamWsSession -> StreamDevHost ->
        // DevStreamBox -> the guest's `stream_set_active` + `stream_dispatch`.
        const router = new StreamRouter(TWO_PATH);
        const app = new Server();
        // A dummy Vite target: a @stream-route upgrade never touches it.
        wireStreams(app, { host: '127.0.0.1', port: 65535 }, router);

        await app.listen(0, '127.0.0.1');
        const PORT = app.port;
        try {
            const roundTrip = (route: string): Promise<Buffer> =>
                new Promise<Buffer>((resolve, reject) => {
                    const ws = new WebSocket(`ws://127.0.0.1:${String(PORT)}${route}`);
                    ws.binaryType = 'arraybuffer';
                    const timer = setTimeout(() => {
                        reject(new Error(`no reply from ${route} within 3s`));
                    }, 3000);
                    ws.onopen = (): void => {
                        ws.send(new Uint8Array([0x70, 0x69, 0x6e, 0x67])); // "ping"
                    };
                    ws.onmessage = (ev: MessageEvent): void => {
                        clearTimeout(timer);
                        resolve(Buffer.from(ev.data as ArrayBuffer));
                        ws.close();
                    };
                    ws.onerror = (): void => {
                        clearTimeout(timer);
                        reject(new Error(`websocket error on ${route}`));
                    };
                });
            const [alpha, beta] = await Promise.all([roundTrip('/alpha'), roundTrip('/beta')]);
            expect(alpha).toEqual(Buffer.from('Aping'));
            expect(beta).toEqual(Buffer.from('Bping'));
        } finally {
            app.close();
        }
    });

    it('devhost-old-artifact-compat: a pre-selection artifact loads and works at index 0', () => {
        // PERMITTED BEHAVIOR: an artifact built before `stream_set_active` existed loads, treats
        // select() as a no-op, and dispatches normally (its only box is index 0).
        const box = DevStreamBox.load(PREPATCH);
        expect(box.hasRings).toBe(true);
        box.select(0);
        expect(box.onConnect(0x31n, 'acme.toil', '/').kind).toBe('accept');
        // The echo fixture's own hook body: the reply is exactly the inbound bytes.
        expect(box.onMessage(0x31n, IN)).toEqual({ kind: 'reply', frames: [IN] });
        // An out-of-range selection cannot trap either: with no export to set, the guest keeps its own
        // default and the single box keeps answering.
        box.select(3);
        expect(box.onMessage(0x31n, Buffer.from('after'))).toEqual({
            kind: 'reply',
            frames: [Buffer.from('after')],
        });

        // The same artifact through the session driver (the real dev-server consumer), including a
        // caller that passes a non-zero index for a one-box artifact.
        const host = new StreamDevHost(PREPATCH_PATH);
        expect(host.acceptUpgrade('c1', 'acme.toil', '/echo', 0).kind).toBe('accepted');
        expect(host.acceptUpgrade('c2', 'acme.toil', '/echo', 5).kind).toBe('accepted');
        expect(host.dispatch('c1', IN)).toEqual({ kind: 'reply', frames: [IN] });
        expect(host.dispatch('c2', IN)).toEqual({ kind: 'reply', frames: [IN] });

        // And through the router, with a context that omits streamIndex entirely.
        const router = new StreamRouter(PREPATCH_PATH);
        const ws = new MockWs();
        router.onUpgrade(ws, {
            kind: 'stream',
            route: '/echo',
            url: '/echo',
            authority: 'acme.toil',
        });
        ws.emitMessage(IN);
        expect(ws.sent).toEqual([IN]);
        expect(ws.closed).toEqual([]);
    });

    it('devhost-old-artifact-compat non-vacuous control: the pristine artifact really lacks the export', () => {
        // Without this the compat case could pass while exercising nothing: the missing export must be
        // genuinely absent, so the host's optional-call handling is what keeps the load working.
        expect(exportedNames(PREPATCH)).not.toContain('stream_set_active');
        expect(exportedNames(PREPATCH)).toContain('stream_dispatch');
        const ref: { memory: WebAssembly.Memory | null } = { memory: null };
        const inst = new WebAssembly.Instance(
            new WebAssembly.Module(new Uint8Array(PREPATCH)),
            buildStreamImports(ref, freshStreamBoxState()),
        );
        const ex = inst.exports as unknown as Record<string, ((i: number) => void) | undefined>;
        expect(ex['stream_set_active']).toBeUndefined();
        // EFFECTIVE KNOWN-BAD CONTROL: the prohibited host shape (calling the export unconditionally,
        // i.e. without the `?.` in DevStreamBox.dispatch) throws on exactly this artifact.
        expect(() => {
            const call = ex['stream_set_active'];
            if (call === undefined) throw new TypeError('stream_set_active is not a function');
            call(0);
        }).toThrow(TypeError);
    });
});

describe('dev stream LIVE round-trip (wireStreams over a real WebSocket)', () => {
    it('echoes a binary frame end-to-end through app.upgrade + app.ws', async () => {
        const router = new StreamRouter(ECHO_PATH);
        const route = [...parseStreamCatalog(ECHO).keys()][0];
        const app = new Server();
        // A dummy Vite target: a @stream-route upgrade never touches it (it goes to the StreamRouter).
        wireStreams(app, { host: '127.0.0.1', port: 65535 }, router);

        await app.listen(0, '127.0.0.1');
        const PORT = app.port;
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

describe('Server.Stream client (doc 08 8.2 makeStreamClient)', () => {
    it('connects + echoes through a real WebSocket end to end', async () => {
        const router = new StreamRouter(ECHO_PATH);
        const route = [...parseStreamCatalog(ECHO).keys()][0];
        const app = new Server();
        wireStreams(app, { host: '127.0.0.1', port: 65535 }, router);

        await app.listen(0, '127.0.0.1');
        const PORT = app.port;
        try {
            // The generated client would call makeStreamClient({ Echo: route }) -> globalThis.__toilStream.
            const stream = makeStreamClient({ Echo: route }, `ws://127.0.0.1:${String(PORT)}`);
            const channel = await stream.Echo.connect();
            const echoed = await new Promise<Uint8Array>((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('no echo within 3s'));
                }, 3000);
                channel.onMessage((d) => {
                    clearTimeout(timer);
                    resolve(d);
                });
                channel.send(new Uint8Array([0x68, 0x69])); // "hi"
            });
            expect(Buffer.from(echoed)).toEqual(Buffer.from('hi'));
            channel.close();
        } finally {
            app.close();
        }
    });

    it('encodes a typed @data message on send (doc 03 2.5)', async () => {
        const router = new StreamRouter(ECHO_PATH);
        const route = [...parseStreamCatalog(ECHO).keys()][0];
        const app = new Server();
        wireStreams(app, { host: '127.0.0.1', port: 65535 }, router);

        await app.listen(0, '127.0.0.1');
        const PORT = app.port;
        try {
            // A typed class: the encoder serializes { text } -> bytes (stands in for ChatMsg.encode()).
            const encode = (m: { text: string }): Uint8Array => new TextEncoder().encode(m.text);
            const stream = makeStreamClient({ Echo: route }, `ws://127.0.0.1:${String(PORT)}`, {
                Echo: encode,
            });
            const channel = await stream.Echo.connect();
            const echoed = await new Promise<Uint8Array>((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('no echo within 3s'));
                }, 3000);
                channel.onMessage((d) => {
                    clearTimeout(timer);
                    resolve(d);
                });
                // Send a TYPED message; the channel must encode it before the raw WS send.
                (channel.send as unknown as (m: { text: string }) => void)({ text: 'typed' });
            });
            // The echo server returns the raw bytes it received -> proves the encoder ran on send.
            expect(Buffer.from(echoed)).toEqual(Buffer.from('typed'));
            channel.close();
        } finally {
            app.close();
        }
    });
});

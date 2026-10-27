import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer, serverArtifacts } from '../src/compiler/index.js';
import { loadConfig } from '../src/compiler/config.js';
import { startDevServer } from '../src/devserver/server.js';
import { startBuiltServer } from '../src/devserver/production.js';
import { startDaemonRuntime } from '../src/devserver/daemon/runtime.js';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { StreamDevHost } from '../src/devserver/stream/manager.js';

const root = mkdtempSync(join(tmpdir(), 'toil-logging-'));
const request = { method: 'GET', path: '/', headers: [], body: new Uint8Array(0) };
const daemonConfig = {
    region: null,
    standbyRegion: null,
    defaultIntervalMs: 3600000,
    tickBudgetMs: 30000,
    gasTick: 0,
    maxTasks: 64,
};
const emit = `
@data class Details { answer: i32 = 42; }
function emit(): void {
    Log.debug('debug');
    Log.info('héllo 🌍');
    Log.warn(42);
    Log.error([1, 2]);
    Log.log(new Details());
    Log.info([new Details()]);
    Log.info(new Uint8Array(2));
    Log.info(<string | null>null);
    Log.error(new Error('timeout'));
}
`;
let enabledWasm: string;
let disabledWasm: string;
let coldWasm: string;
let streamWasm: string;

beforeAll(async () => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('node_modules/toilscript'), join(root, 'node_modules/toilscript'), 'dir');
    mkdirSync(join(root, 'server'));
    mkdirSync(join(root, 'static'));
    writeFileSync(join(root, 'static/index.html'), '<html>app</html>');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
        join(root, 'toilconfig.json'),
        JSON.stringify({
            entries: ['server/main.ts'],
            targets: { release: { outFile: 'build/server/release.wasm' } },
            options: { runtime: 'stub', memoryBase: 65536, optimizeLevel: 0, shrinkLevel: 0 },
        }),
    );
    writeFileSync(
        join(root, 'server/main.ts'),
        emit +
            `
export function handle(ofs: i32, len: i32): i64 {
    emit();
    const response = new Uint8Array(8);
    response[0] = 200;
    return (<i64>response.dataStart << 32) | 8;
}
export function render(ofs: i32, len: i32): i64 { return handle(ofs, len); }
`,
    );
    writeFileSync(
        join(root, 'server/jobs.ts'),
        emit +
            `
@daemon class Jobs {
    @job onStart(): void { Log.info('daemon started'); }
    @scheduled('1h') tick(): void { emit(); }
}
`,
    );
    writeFileSync(
        join(root, 'server/main.stream.ts'),
        emit +
            `
@stream('logging') class LoggingStream {
    @message reply(packet: StreamPacket): StreamOutbound {
        emit();
        return StreamOutbound.reply(packet.bytes());
    }
}
`,
    );
    // A default production build must silence logs in Wasm itself, on every host.
    await buildServer(root);
    disabledWasm = join(root, 'disabled.wasm');
    writeFileSync(disabledWasm, readFileSync(join(root, 'build/server/release.wasm')));
    for (const artifact of [serverArtifacts(root).cold, serverArtifacts(root).stream]) {
        const module = new WebAssembly.Module(readFileSync(artifact));
        expect(WebAssembly.Module.imports(module).some((item) => item.name === 'server_log')).toBe(
            false,
        );
    }
    await buildServer(root, false, {}, true);
    enabledWasm = join(root, 'build/server/release.wasm');
    coldWasm = serverArtifacts(root).cold;
    streamWasm = serverArtifacts(root).stream;
}, 30000);

afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

function capture() {
    return {
        info: vi.spyOn(console, 'info').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
}

function expectMessages(output: ReturnType<typeof capture>) {
    expect(output.info).toHaveBeenCalledWith('[toil guest]', 'debug');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', 'héllo 🌍');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', '{"answer":42}');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', '[{"answer":42}]');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', '[0,0]');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', 'null');
    expect(output.warn).toHaveBeenCalledWith('[toil guest]', '42');
    expect(output.error).toHaveBeenCalledWith('[toil guest]', '[1,2]');
    expect(output.error).toHaveBeenCalledWith('[toil guest]', 'Error: timeout');
}

function expectQuiet(output: ReturnType<typeof capture>) {
    expect(output.info).not.toHaveBeenCalled();
    expect(output.warn).not.toHaveBeenCalled();
    expect(output.error).not.toHaveBeenCalled();
}

async function freePort(): Promise<number> {
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done) => reservation.close(() => done()));
    return port;
}

describe('compiled server logging', () => {
    it('logs strings, numbers, arrays, and objects during requests and SSR', () => {
        const output = capture();
        const module = new WasmServerModule(enabledWasm);
        module.refresh();
        expect(module.dispatch(request).status).toBe(200);
        expectMessages(output);
        vi.clearAllMocks();
        expect(module.dispatchRender(request)).toHaveLength(8);
        expectMessages(output);
    });

    it('keeps a production artifact quiet even when the host permits logging', () => {
        const output = capture();
        const module = new WasmServerModule(disabledWasm, true);
        module.refresh();
        expect(module.dispatch(request).status).toBe(200);
        expect(module.dispatchRender(request)).toHaveLength(8);
        expectQuiet(output);
        const wasm = new WebAssembly.Module(readFileSync(disabledWasm));
        expect(WebAssembly.Module.imports(wasm).some((item) => item.name === 'server_log')).toBe(
            false,
        );
    });

    it.each([true, false])(
        'applies logging=%s to daemon startup and scheduled calls',
        (logging) => {
            const output = capture();
            const runtime = startDaemonRuntime({
                coldWasmFile: coldWasm,
                daemon: daemonConfig,
                logging,
            });
            try {
                expect(runtime).not.toBeNull();
                if (logging)
                    expect(output.info).toHaveBeenCalledWith('[toil guest]', 'daemon started');
                const host = runtime!.host;
                expect(host.runTask(host.tasks[0].name).status).toBe('ok');
                if (logging) expectMessages(output);
                else expectQuiet(output);
            } finally {
                runtime?.close();
            }
        },
    );

    it.each([true, false])('applies logging=%s to resident streams', (logging) => {
        const output = capture();
        const host = new StreamDevHost(streamWasm, logging);
        try {
            expect(host.acceptUpgrade('conn', 'localhost', '/logging').kind).toBe('accepted');
            // Each event gets its own allowance, even after a resident connection has emitted 32 logs.
            for (let i = 0; i < 6; i++) {
                vi.clearAllMocks();
                expect(host.dispatch('conn', Buffer.from('hello')).kind).toBe('reply');
                if (logging) expectMessages(output);
                else expectQuiet(output);
            }
        } finally {
            host.close('conn');
        }
    });

    it.each([
        ['dev', undefined, true],
        ['dev', false, false],
        ['production', undefined, false],
        ['production', true, true],
    ] as const)('%s server with logging=%s emits=%s over HTTP', async (mode, logging, emits) => {
        const output = capture();
        const port = await freePort();
        const server =
            mode === 'dev'
                ? await startDevServer({
                      root,
                      port,
                      wasmFile: enabledWasm,
                      vite: { host: '127.0.0.1', port: 1 },
                      logging,
                  })
                : await startBuiltServer({
                      root,
                      port,
                      staticRoot: join(root, 'static'),
                      wasmFile: enabledWasm,
                      threads: 1,
                      logging,
                  });
        try {
            const response = await fetch(`http://127.0.0.1:${port}/`);
            expect(response.status).toBe(200);
            await response.arrayBuffer();
            if (emits) expectMessages(output);
            else expectQuiet(output);
        } finally {
            await server.close();
        }
    });

    it('preserves the mode default in config and accepts explicit production opt-in', async () => {
        expect((await loadConfig({ root })).logging).toBeUndefined();
        writeFileSync(
            join(root, 'toil.config.mjs'),
            'export default { server: { logging: true } };',
        );
        expect((await loadConfig({ root })).logging).toBe(true);
    });
});

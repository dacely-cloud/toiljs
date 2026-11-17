import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer, serverArtifacts } from '../src/compiler/index.js';
import { loadConfig } from '../src/compiler/config.js';
import { startDevServer } from '../src/devserver/server.js';
import { startBuiltServer } from '../src/devserver/production.js';
import { startDaemonRuntime } from '../src/devserver/daemon/runtime.js';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { buildHostImports, freshDispatchState } from '../src/devserver/runtime/host.js';
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
let formatterCalls: i32 = 0;
class CustomDetails {
    toJSON(): JSON {
        formatterCalls++;
        return JSON.obj().set('custom', JSON.of<string>('value')).set('count', JSON.of<i32>(7));
    }
}
class Printable {
    toString(): string { return 'custom object'; }
}
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
    console.log('console log');
    console.debug(false);
    console.info('console héllo 🌍');
    console.warn(12.5);
    console.error(new Error('console timeout'));
    console.log(new Details());
    console.info([1, 2]);
    console.info(<string | null>null);
    console.log();
    console.debug();
    console.info();
    console.warn();
    console.error();
    console.log('\\u001b[32mgreen 🌍\\u001b[0m');
    console.warn('\\u001b[33myellow\\u001b[0m');
    console.error('\\u001b[31mred\\u001b[0m');
    console.log(new CustomDetails());
    console.log(JSON.parse('{"nested":{"active":true},"items":[1,null,"value"]}'));
    const nested = new Array<Array<Details | null>>();
    nested.push([new Details(), null]);
    console.log(nested);
    console.log(new Printable());
    console.log(JSON.obj().set('text', JSON.of<string>('\\u001b]52;c;attack\\u0007\\n\\u009b\\u202e')));
    console.error('attack\\u001b]52;c;clipboard\\u0007\\u001b[2J\\r\\n[trusted] forged\\u202e');
    console.warn('\\u001b[33munclosed color');
}
`;
let enabledWasm: string;
let disabledWasm: string;
let coldWasm: string;
let disabledColdWasm: string;
let streamWasm: string;

beforeAll(async () => {
    // The dedicated daemon thread runs emitted JS outside Vitest's loader.
    execFileSync('npm', ['run', 'build:devserver'], { cwd: resolve('.'), stdio: 'pipe' });
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
    if (!__TOIL_LOGGING) assert(formatterCalls == 0, 'disabled logs must not call formatters');
    const response = new Uint8Array(8);
    response[0] = 200;
    return (<i64>response.dataStart << 32) | 8;
}
export function render(ofs: i32, len: i32): i64 { return handle(ofs, len); }
export function oversized(): void {
    console.log(JSON.obj().set('text', JSON.of<string>('x'.repeat(4096))));
}
`,
    );
    writeFileSync(
        join(root, 'server/jobs.ts'),
        emit +
            `
@daemon class Jobs {
    @job onStart(): void {
        Log.info('daemon started');
        console.info('console daemon started');
        console.log('\\u001b[36mdaemon ready\\u001b[0m');
    }
    @scheduled('1s') tick(): void { emit(); }
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
    disabledColdWasm = join(root, 'disabled-cold.wasm');
    writeFileSync(disabledColdWasm, readFileSync(serverArtifacts(root).cold));
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
    expect(output.info).toHaveBeenCalledWith('[toil guest]', 'console log');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', 'false');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', 'console héllo 🌍');
    expect(output.warn).toHaveBeenCalledWith('[toil guest]', '12.5');
    expect(output.error).toHaveBeenCalledWith('[toil guest]', 'Error: console timeout');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', '[1,2]');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', '');
    expect(output.warn).toHaveBeenCalledWith('[toil guest]', '');
    expect(output.error).toHaveBeenCalledWith('[toil guest]', '');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', '\u001b[32mgreen 🌍\u001b[0m');
    expect(output.warn).toHaveBeenCalledWith('[toil guest]', '\u001b[33myellow\u001b[0m');
    expect(output.error).toHaveBeenCalledWith('[toil guest]', '\u001b[31mred\u001b[0m');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', '{"custom":"value","count":7}');
    expect(output.info).toHaveBeenCalledWith(
        '[toil guest]',
        '{"nested":{"active":true},"items":[1,null,"value"]}',
    );
    expect(output.info).toHaveBeenCalledWith('[toil guest]', '[[{"answer":42},null]]');
    expect(output.info).toHaveBeenCalledWith('[toil guest]', 'custom object');
    expect(output.info).toHaveBeenCalledWith(
        '[toil guest]',
        '{"text":"\\u001b]52;c;attack\\u0007\\n\\x9b\\u202e"}',
    );
    expect(output.error).toHaveBeenCalledWith(
        '[toil guest]',
        'attack\\x1b]52;c;clipboard\\x07\\x1b[2J\\x0d\\x0a[trusted] forged\\u202e',
    );
    expect(output.warn).toHaveBeenCalledWith('[toil guest]', '\u001b[33munclosed color\u001b[0m');
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

    it('applies the UTF-8 message cap after object serialization', () => {
        const output = capture();
        const ref = { memory: null as WebAssembly.Memory | null };
        const instance = new WebAssembly.Instance(
            new WebAssembly.Module(readFileSync(enabledWasm)),
            buildHostImports(ref, freshDispatchState()),
        );
        ref.memory = instance.exports.memory as WebAssembly.Memory;
        expect(() => (instance.exports.oversized as () => void)()).toThrow(
            /at most 4096 UTF-8 bytes/,
        );
        expectQuiet(output);
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
                if (logging) {
                    expect(output.info).toHaveBeenCalledWith(
                        '[toil guest]',
                        'console daemon started',
                    );
                    expect(output.info).toHaveBeenCalledWith(
                        '[toil guest]',
                        '\u001b[36mdaemon ready\u001b[0m',
                    );
                }
                const host = runtime!.host;
                expect(host.runTask(host.tasks[0].name).status).toBe('ok');
                if (logging) expectMessages(output);
                else expectQuiet(output);
            } finally {
                runtime?.close();
            }
        },
    );

    it.each([
        ['enabled', true, true],
        ['enabled', false, false],
        ['disabled', true, false],
    ] as const)(
        'preserves daemon console output and ANSI bytes on a real worker (%s artifact, logging=%s)',
        async (artifact, logging, emits) => {
            const script = `
                import { startDaemonWorker } from ${JSON.stringify(resolve('build/devserver/daemon/runtime.js'))};
                const worker = startDaemonWorker(${JSON.stringify({
                    coldWasmFile: artifact === 'enabled' ? coldWasm : disabledColdWasm,
                    daemon: daemonConfig,
                    logging,
                })});
                try {
                    await worker.ready;
                    await new Promise((done) => setTimeout(done, 1200));
                } finally {
                    await worker.close();
                }
            `;
            // A real file avoids passing --input-type through to the worker's execArgv.
            const scriptFile = join(root, `worker-${artifact}-${logging}.mjs`);
            writeFileSync(scriptFile, script);
            const { stdout, stderr } = await promisify(execFile)(process.execPath, [scriptFile], {
                timeout: 10000,
            });
            if (emits) {
                const lines = stdout.split('\n');
                expect(lines).toContain('[toil guest] console daemon started');
                expect(lines).toContain('[toil guest] \u001b[36mdaemon ready\u001b[0m');
                expect(lines).toContain('[toil guest] console log');
                expect(lines).toContain('[toil guest] \u001b[32mgreen 🌍\u001b[0m');
                expect(stderr.split('\n')).toContain('[toil guest] \u001b[33myellow\u001b[0m');
                expect(stderr.split('\n')).toContain('[toil guest] \u001b[31mred\u001b[0m');
                expect(lines).toContain('[toil guest] {"custom":"value","count":7}');
                expect(lines).toContain('[toil guest] [[{"answer":42},null]]');
                expect(stderr.split('\n')).toContain(
                    '[toil guest] attack\\x1b]52;c;clipboard\\x07\\x1b[2J\\x0d\\x0a[trusted] forged\\u202e',
                );
                expect(stderr.split('\n')).toContain(
                    '[toil guest] \u001b[33munclosed color\u001b[0m',
                );
                expect(stdout + stderr).not.toContain('\u001b]52;');
                expect(stdout + stderr).not.toContain('\u001b[2J');
            } else {
                expect(stdout).not.toContain('[toil guest]');
                expect(stderr).not.toContain('[toil guest]');
            }
        },
        12000,
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

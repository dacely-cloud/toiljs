import { execFileSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/compiler/index.js';
import { loadConfig } from '../src/compiler/config.js';

const root = mkdtempSync(join(tmpdir(), 'toil-daemon-worker-'));
const cfg = {
    region: null,
    standbyRegion: null,
    defaultIntervalMs: 60000,
    tickBudgetMs: 30000,
    gasTick: 0,
    maxTasks: 64,
};
let built: typeof import('../build/devserver/production.js');
let runtime: typeof import('../build/devserver/daemon/runtime.js');
let database: typeof import('../build/devserver/db/index.js');
let dev: typeof import('../build/devserver/server.js');
let cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    // Workers execute the package's emitted JS in a real Node thread, outside Vitest's loader.
    execFileSync('npm', ['run', 'build:devserver'], { cwd: resolve('.'), stdio: 'pipe' });
    built = await import('../build/devserver/production.js');
    runtime = await import('../build/devserver/daemon/runtime.js');
    database = await import('../build/devserver/db/index.js');
    dev = await import('../build/devserver/server.js');
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'), 'dir');
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
            options: {
                runtime: 'stub',
                memoryBase: 65536,
                optimizeLevel: 0,
                shrinkLevel: 0,
                lib: [resolve('server/globals/environment.ts'), resolve('server/globals/email.ts')],
            },
        }),
    );
    writeFileSync(
        join(root, 'server/models.ts'),
        `
@data export class Key { id:i32=0; }
@data export class Row { stage:i32=0; constructor(stage:i32=0){this.stage=stage;} }
@database export class App {
  @collection static control:Documents<Key,Row>;
  @collection static starts:Counter<Key>;
  @collection static events:Events<Key,Row>;
  @collection static members:Membership<Key,Key>;
  @collection static page:View<Key,Row>;
}
`,
    );
    writeFileSync(
        join(root, 'server/main.ts'),
        `
import {Server,RestHandler,ToilHandler,Response} from 'toiljs/server/runtime';
import {App,Key,Row} from './models';
@rest('worker') class Routes {
  @get('/state') state():Response {
    const row=App.control.get(new Key());return Response.text(row===null?'none':row.stage.toString());
  }
  @get('/starts') starts():Response {return Response.text(App.starts.get(new Key()).toString());}
  @get('/page') page():Response {
    const row=App.page.get(new Key());return Response.text(row===null?'none':row.stage.toString());
  }
  @post('/run') run():Response {App.control.upsert(new Key(),new Row(10));return Response.text('queued');}
  @post('/trap') trap():Response {App.control.upsert(new Key(),new Row(13));return Response.text('queued');}
  @post('/hang') hang():Response {App.control.upsert(new Key(),new Row(99));return Response.text('queued');}
  @post('/increment') increment():Response {App.starts.add(new Key(),1);return Response.text('added');}
  @post('/services') services():Response {App.control.upsert(new Key(),new Row(20));return Response.text('queued');}
}
Server.handler=():ToilHandler=>new RestHandler();
export * from 'toiljs/server/runtime/exports';
`,
    );
    writeFileSync(
        join(root, 'server/jobs.ts'),
        `
import {App,Key,Row} from './models';
function busy():void { const end=Date.now()+1500;while(Date.now()<end){} }
@daemon class Jobs {
  @job onStart():void {
    const key=new Key();App.starts.add(key,1);
    App.control.upsert(key,new Row(1));busy();
    App.events.append(key,new Row(7));App.members.add(key,key);
    const events=App.events.latest(key,10);const members=App.members.list(key,10);
    const keys=new Array<Key>();keys.push(key);const rows=App.control.getMany(keys);
    App.page.publish(key,new Row(events.length+members.length+rows.length));
    App.control.upsert(key,new Row(2));
  }
  @scheduled('1s') @job tick():void {
    const key=new Key();const row=App.control.get(key);if(row===null)return;
    if(row.stage===20){
      const plain=Environment.get('WORKER_PLAIN');const secret=Environment.getSecure('WORKER_SECRET');
      assert(plain!==null && plain.length===1024 && secret!==null && secret.length===1536);
      assert(Environment.get('WORKER_SECRET')===null && Environment.getSecure('WORKER_PLAIN')===null);
      const before=Db.budget();App.control.get(key);const after=Db.budget();
      assert(after.ops===before.ops+1 && after.bytes>before.bytes);
      assert(EmailService.send('worker@example.com','L4','shared service','worker-test')===EmailStatus.Sent);
      App.control.upsert(key,new Row(21));return;
    }
    if(row.stage===99){App.control.upsert(key,new Row(5));while(true){}}
    if(row.stage===13){App.control.upsert(key,new Row(6));assert(false,'expected task trap');}
    if(row.stage!==10)return;
    App.control.upsert(key,new Row(3));busy();App.control.upsert(key,new Row(4));
  }
}
`,
    );
    await buildServer(root);
    const schema = `
@data class Key { id:i32=0; }
@data class Row { stage:i32=0; constructor(stage:i32=0){this.stage=stage;} }
@database class App {
  @collection static control:Documents<Key,Row>;
  @collection static page:View<Key,Row>;
  DERIVE
}
`;
    const derive = `@derive rebuild():void {
      App.page.publish(new Key(),new Row(8));
      const end=Date.now()+1500;while(Date.now()<end){}
      App.page.publish(new Key(),new Row(9));
    }`;
    const daemon =
        '@daemon class Jobs { onStart():void {App.control.upsert(new Key(),new Row(7));} }';
    for (const [name, source, target] of [
        ['cold-derive', schema.replace('DERIVE', derive) + daemon, 'cold'],
        [
            'hot-derive',
            schema.replace('DERIVE', derive) + 'export function handle(o:i32,l:i32):i64{return 0;}',
            'hot',
        ],
        ['plain-cold', schema.replace('DERIVE', '') + daemon, 'cold'],
    ]) {
        const file = join(root, `${name}.ts`);
        writeFileSync(file, source);
        execFileSync(
            process.execPath,
            [
                resolve('node_modules/toilscript/bin/toilscript.js'),
                file,
                '-o',
                join(root, `${name}.wasm`),
                '--targetMode',
                target,
                '--runtime',
                'stub',
            ],
            { stdio: 'pipe' },
        );
    }
}, 30000);

beforeEach(() => {
    vi.stubEnv('TOIL_DEV_CHECK_DB_LIMITS', '1');
    database.__resetDbForTests();
    rmSync(join(root, '.toil'), { recursive: true, force: true });
});
afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups = [];
    vi.unstubAllEnvs();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return address.port;
}

async function waitFor<T>(read: () => Promise<T>, expected: T): Promise<void> {
    const deadline = Date.now() + 7000;
    let actual: T;
    do {
        actual = await read();
        if (actual === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    expect(actual).toBe(expected);
}

async function server(mode: 'dev' | number, enabled = true) {
    const port = await freePort();
    const common = {
        root,
        port,
        nodeMode: 'hot',
        daemon: { ...cfg, enabled },
        wasmFile: join(root, 'build/server/release.wasm'),
        coldWasmFile: join(root, 'build/server/release-cold.wasm'),
    };
    const running =
        mode === 'dev'
            ? await dev.startDevServer({ ...common, vite: { host: '127.0.0.1', port: 1 } })
            : await built.startBuiltServer({
                  ...common,
                  staticRoot: join(root, 'static'),
                  threads: mode,
              });
    cleanups.push(() => running.close());
    const get = async (path: string, method = 'GET') => {
        const response = await fetch(`http://127.0.0.1:${port}/worker/${path}`, { method });
        expect(response.status).toBe(200);
        return response.text();
    };
    return { running, get };
}

describe('L4 in a dedicated thread alongside L1', () => {
    it.each([1, 2, 'dev'] as const)(
        'serves L1 during L4 startup and ticks (%s HTTP workers)',
        async (mode) => {
            const { get } = await server(mode);
            await waitFor(() => get('state'), '1');
            // Logical overlap, not just a latency threshold: the startup job is still computing.
            expect(await get('increment', 'POST')).toBe('added');
            expect(await get('state')).toBe('1');
            await waitFor(() => get('state'), '2');
            expect(await get('starts')).toBe('2'); // exactly one daemon, including with two HTTP workers
            expect(await get('page')).toBe('3'); // scans, result pulls, and worker writes share the L1 DB
            await get('run', 'POST');
            await waitFor(() => get('state'), '3');
            expect(await get('increment', 'POST')).toBe('added');
            expect(await get('state')).toBe('3');
            await waitFor(() => get('state'), '4');
            expect(await get('starts')).toBe('3');
            const snapshot = JSON.parse(readFileSync(join(root, '.toil/devdata.json'), 'utf8'));
            expect(Object.values(snapshot.counters)).toEqual(['3']);
            await get('trap', 'POST');
            await waitFor(() => get('state'), '6');
            await get('run', 'POST');
            await waitFor(() => get('state'), '4');
        },
        20000,
    );

    it('honors explicit disable while continuing to serve L1', async () => {
        const { get } = await server(1, false);
        await new Promise((resolve) => setTimeout(resolve, 650));
        expect(await get('state')).toBe('none');
        expect(await get('starts')).toBe('0');
    });

    it('shares parent-owned environment and email services and preserves DB charges', async () => {
        const { get } = await server(1);
        await waitFor(() => get('state'), '2');
        const { installDevBlobEnvironment } = await import('../build/devserver/config/env.js');
        const { __sentEmails } = await import('../build/devserver/email/index.js');
        const uninstall = installDevBlobEnvironment({
            vars: new Map([['WORKER_PLAIN', 'v'.repeat(1024)]]),
            secrets: new Map([['WORKER_SECRET', 's'.repeat(1536)]]),
        });
        cleanups.push(async () => uninstall());
        await get('services', 'POST');
        await waitFor(() => get('state'), '21');
        expect(__sentEmails.at(-1)).toMatchObject({ to: 'worker@example.com', subject: 'L4' });
    }, 10000);

    it('follows nodeMode when enabled is omitted, and permits an explicit override', async () => {
        const options = { coldWasmFile: join(root, 'build/server/release-cold.wasm'), daemon: cfg };
        expect(runtime.startDaemonWorker({ ...options, nodeMode: 'hot' })).toBeNull();
        expect(
            runtime.startDaemonWorker({
                ...options,
                nodeMode: 'all',
                daemon: { ...cfg, enabled: false },
            }),
        ).toBeNull();
        const worker = runtime.startDaemonWorker({ ...options, nodeMode: 'all' })!;
        cleanups.push(() => worker.close());
        expect(worker.threadId).toBeGreaterThan(0);
        await worker.ready;
        await worker.close();
        await worker.close(); // idempotent, including after exit
    });

    it('reloads the cold artifact without starting one daemon per HTTP worker', async () => {
        const { get } = await server(2);
        await waitFor(() => get('state'), '2');
        const cold = join(root, 'build/server/release-cold.wasm');
        const future = new Date(Date.now() + 5000);
        utimesSync(cold, future, future);
        await waitFor(() => get('starts'), '2');
        await waitFor(() => get('state'), '2');
        expect(await get('starts')).toBe('2');
    }, 15000);

    it('terminates a stuck synchronous daemon on shutdown', async () => {
        const { get, running } = await server(1);
        await waitFor(() => get('state'), '2');
        await get('hang', 'POST');
        await waitFor(() => get('state'), '5');
        expect(await get('starts')).toBe('1');
        const start = Date.now();
        await running.close();
        expect(Date.now() - start).toBeLessThan(3500);
    }, 12000);

    it.each(['cold', 'hot'])(
        'keeps %s-artifact background materializers off L1',
        async (artifact) => {
            const { get } = await server(1, false);
            const worker = runtime.startDaemonWorker({
                coldWasmFile: join(
                    root,
                    artifact === 'cold' ? 'cold-derive.wasm' : 'plain-cold.wasm',
                ),
                hotWasmFile: artifact === 'hot' ? join(root, 'hot-derive.wasm') : undefined,
                daemon: { ...cfg, enabled: true },
            })!;
            cleanups.push(() => worker.close());
            await waitFor(() => get('page'), '8');
            expect(await get('state')).toBe('7');
            expect(await get('page')).toBe('8'); // request completed during the materializer's busy loop
            await worker.ready;
            expect(await get('page')).toBe('9');
        },
        10000,
    );
});

describe('daemon cohosting config', () => {
    it.each([true, false, undefined])(
        'preserves enabled=%s through config resolution',
        async (enabled) => {
            const configRoot = mkdtempSync(join(root, 'config-'));
            writeFileSync(
                join(configRoot, 'toil.config.mjs'),
                `export default ${JSON.stringify({ server: { nodeMode: 'hot', daemon: { enabled } } })}`,
            );
            expect((await loadConfig({ root: configRoot })).daemon.enabled).toBe(enabled);
        },
    );
    it('rejects a non-boolean enable flag', async () => {
        const configRoot = mkdtempSync(join(root, 'config-'));
        writeFileSync(
            join(configRoot, 'toil.config.mjs'),
            'export default {server:{daemon:{enabled:"false"}}}',
        );
        await expect(loadConfig({ root: configRoot })).rejects.toThrow(
            'server.daemon.enabled must be a boolean',
        );
    });
});

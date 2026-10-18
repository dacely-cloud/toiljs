import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { __resetDbForTests, configureDbPersistence } from '../src/devserver/db/index.js';

const root = mkdtempSync(join(tmpdir(), 'toil-atomic-'));
let module: WasmServerModule;
beforeAll(() => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
    writeFileSync(
        join(root, 'app.ts'),
        `
import { Server,RestHandler,ToilHandler,Response,RouteContext } from 'toiljs/server/runtime';
@data class Partition {name:string='';constructor(name:string=''){this.name=name;}}
@data class Key {id:i32=0;constructor(id:i32=0){this.id=id;}}
@data class Value {text:string='';constructor(text:string=''){this.text=text;}}
@database class App {
 @collection({replication:'localOnly',placement:'local'}) static messages:Documents<Key,Value>;
 @collection({replication:'localOnly',placement:'local'}) static threads:Documents<Key,Value>;
 @collection static ordinary:Documents<Key,Value>;
}
@rest('atomic') class Routes {
 @post('/send') send(ctx:RouteContext):Response {
   const batch=Db.atomic(new Partition('thread-1'),ctx.request.body);
   batch.create(App.messages,new Key(1),new Value('hello'));
   batch.create(App.threads,new Key(),new Value('count1'));
   const success=batch.commit();const meter=Db.budget();
   return Response.text((success?'yes':'no')+':'+meter.ops.toString()+':'+meter.writes.toString());
 }
 @post('/conflict') conflict(ctx:RouteContext):Response {
   const batch=Db.atomic(new Partition('thread-1'),ctx.request.body);
   batch.create(App.messages,new Key(2),new Value('must-not-appear'));
   batch.create(App.threads,new Key(),new Value('conflict'));
   return Response.text(batch.commit()?'yes':'no');
 }
 @post('/update') update(ctx:RouteContext):Response {
   const batch=Db.atomic(new Partition('thread-1'),ctx.request.body);
   const expected=new Value('count1');
   batch.compareExchange(App.threads,new Key(),new DocumentSnapshot<Value>(expected,expected.encode()),new Value('count2'));
   const message=new Value('hello');
   batch.compareDelete(App.messages,new Key(1),new DocumentSnapshot<Value>(message,message.encode()));
   return Response.text(batch.commit()?'yes':'no');
 }
 @get('/read') read(ctx:RouteContext):Response {
   const p=new Partition('thread-1');
   const thread=App.threads.partition(p).get(new Key());
   const message=App.messages.partition(p).get(new Key(1));
   const other=App.messages.partition(new Partition('thread-2')).get(new Key(1));
   const leaked=App.messages.get(new Key(1));
   const failed=App.messages.partition(p).get(new Key(2));
   return Response.text((thread==null?'none':thread.text)+':'+(message==null?'none':message.text)+':'+(other==null&&leaked==null&&failed==null?'isolated':'leak'));
 }
 @get('/forbidden') forbidden(ctx:RouteContext):Response {
   const batch=Db.atomic(new Partition('thread-1'),ctx.request.body);
   batch.create(App.messages,new Key(3),new Value('forbidden'));batch.commit();return Response.empty(204);
 }
 @post('/policy') policy(ctx:RouteContext):Response {
   const batch=Db.atomic(new Partition('thread-1'),ctx.request.body);
   batch.create(App.ordinary,new Key(3),new Value('forbidden'));batch.commit();return Response.empty(204);
 }
 @post('/budget') budget(ctx:RouteContext):Response {
   for(let i=0;i<30;i++)App.ordinary.upsert(new Key(i),new Value('other'));
   return this.send(ctx);
 }
 @post('/trap') trap(ctx:RouteContext):Response {
   this.send(ctx);throw new Error('after atomic commit');
 }
}
Server.handler=():ToilHandler=>new RestHandler();
export * from 'toiljs/server/runtime/exports';
`,
    );
    const result = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ?? resolve('node_modules/toilscript/bin/toilscript.js'),
            'app.ts',
            '-o',
            join(root, 'app.wasm'),
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
        ],
        { cwd: root, encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
}, 30000);
beforeEach(() => {
    __resetDbForTests();
    vi.stubEnv('TOIL_DEV_CHECK_DB_LIMITS', '1');
    module = new WasmServerModule(join(root, 'app.wasm'));
    module.refresh();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const request = (name: string, token = 'send-token-00000001') =>
    module.dispatch({
        method: name === 'read' || name === 'forbidden' ? 'GET' : 'POST',
        path: '/atomic/' + name,
        headers: [],
        body: Buffer.from(token),
    });
const text = (name: string, token?: string) => Buffer.from(request(name, token).body).toString();
it('commits across two collections, accounts for the decision row, and replays the exact batch', () => {
    expect(text('send')).toBe('yes:3:3');
    expect(text('read')).toBe('count1:hello:isolated');
    expect(text('send')).toBe('yes:3:3');
});
it('leaves every record unchanged when one condition conflicts', () => {
    text('send');
    expect(text('conflict', 'conflict-token-00001')).toBe('no');
    expect(text('read')).toBe('count1:hello:isolated');
});
it('atomically deletes and updates, and an old successful retry cannot resurrect later-deleted data', () => {
    text('send');
    expect(text('update', 'update-token-000001')).toBe('yes');
    expect(text('read')).toBe('count2:none:isolated');
    expect(text('send')).toBe('yes:3:3');
    expect(text('read')).toBe('count2:none:isolated');
});
it('rejects reuse of a committed token for different writes', () => {
    text('send');
    expect(() => request('conflict')).toThrow(/Atomic batch failed/);
    expect(text('read')).toBe('count1:hello:isolated');
});
it('enforces Query and collection policy gates before writing', () => {
    expect(() => request('forbidden')).toThrow(/requires an Action/);
    expect(() => request('policy')).toThrow(/localOnly/);
    expect(text('read')).toBe('none:none:isolated');
});
it('rejects an over-budget batch before any of its writes', () => {
    expect(() => request('budget')).toThrow(/TDL020/);
    expect(text('read')).toBe('none:none:isolated');
});
it('persists the committed records and decision across a trapped request and dev reload', () => {
    const filename = join(root, 'atomic-snapshot.json');
    configureDbPersistence(filename);
    expect(() => request('trap')).toThrow(/after atomic commit/);
    __resetDbForTests();
    configureDbPersistence(filename);
    module = new WasmServerModule(join(root, 'app.wasm'));
    module.refresh();
    expect(text('send')).toBe('yes:3:3');
    expect(text('read')).toBe('count1:hello:isolated');
});
it('interleaves two real requests before their commits and permits one complete send', async () => {
    if (typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending !== 'function')
        return;
    const barrier = () => {
        let release!: () => void;
        const promise = new Promise<void>((r) => {
            release = r;
        });
        return { promise, release };
    };
    const firstReady = barrier(),
        secondReady = barrier(),
        resumeFirst = barrier(),
        resumeSecond = barrier();
    const send = (
        token: string,
        ready: ReturnType<typeof barrier>,
        resume: ReturnType<typeof barrier>,
    ) =>
        module.dispatchAsync(
            {
                method: 'POST',
                path: '/atomic/send',
                headers: [],
                body: Buffer.from(token),
            },
            {
                beforeDatabaseOperation: async (point) => {
                    if (point.operation === 'data.atomic_batch') {
                        ready.release();
                        await resume.promise;
                    }
                },
            },
        );
    const first = send('overlap-first-token', firstReady, resumeFirst),
        second = send('overlap-second-token', secondReady, resumeSecond);
    await Promise.all([firstReady.promise, secondReady.promise]);
    resumeFirst.release();
    expect(Buffer.from((await first).body).toString()).toBe('yes:3:3');
    resumeSecond.release();
    expect(Buffer.from((await second).body).toString()).toBe('no:3:3');
    expect(text('read')).toBe('count1:hello:isolated');
});

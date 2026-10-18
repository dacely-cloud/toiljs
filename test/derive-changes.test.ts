import { validateDeriveContinuationArtifacts } from '../src/compiler/index.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { configureDbPersistence, devDb, __resetDbForTests } from '../src/devserver/db/index.js';
import { DaemonHost } from '../src/devserver/daemon/index.js';
import { captureDbKey, deriveChangesFrame } from '../src/devserver/db/changes.js';
import { freshDbState, DbFunctionKind, CollectionFamily } from '../src/devserver/db/types.js';

const root = mkdtempSync(join(tmpdir(), 'toil-changes-'));
const hot = join(root, 'server.wasm'),
    cold = join(root, 'daemon.wasm');
const source = `
import { Server, Response, Request, ToilHandler } from 'toiljs/server/runtime';
@data class Key { id:i32=0; constructor(id:i32=0){this.id=id;} }
@data class Value { text:string=''; constructor(text:string=''){this.text=text;} }
@database class Other { @collection static docs:Documents<Key,Value>; }
@database class App {
  @collection static docs:Documents<Key,Value>;
  @collection static members:Membership<Key,Value>;
  @collection static report:View<Key,Value>;
  @derive rebuild():void {
    const changes=Db.changes();
    let text=changes.fullRescan?'full':'';
    for(let i=0;i<changes.keys.length;i++) {
      const change=changes.keys[i];
      text+=change.database+'/'+change.collection+':'+Key.decode(change.key).id.toString()+';';
    }
    App.report.publish(new Key(),new Value(text));
  }
}
@database class Journal {
  @collection static events:Events<Key,Value>;
  @collection static last:View<Key,Value>;
  @derive rebuild():void {
    const rows=Journal.events.since(new Key(),1);
    Journal.last.publish(new Key(),rows.length>0?rows[0]:new Value('empty'));
  }
}
let continuationOps:i32=0;
@database class Backlog {
  @collection static events:Events<Key,Value>;
  @collection static last:View<Key,Value>;
  @derive fold():void {
    const rows=Backlog.events.since(new Key(),1);
    if(rows.length==0)return;
    Backlog.last.publish(new Key(),rows[0]);
    Db.continueDerive();Db.continueDerive();
    continuationOps=<i32>Db.budget().ops;
  }
}
export function backlogValue():i32 { const row=Backlog.last.get(new Key());return row==null?-1:<i32>parseInt(row.text); }
export function continuationBudget():i32 { return continuationOps; }
@database class ClockDb {
  @collection static live:View<Key,Value>;
  @derive refresh():void { ClockDb.live.publish(new Key(),new Value(Date.now()<2000?'live':'expired')); }
}
function refreshClock():void { new ClockDb().refresh(); }
function foldJournal():void { new Journal().rebuild(); }
function failJournal():void { new Journal().rebuild();throw new Error('after fold'); }
@daemon class Jobs {
  @scheduled('1h') @job expire():void { Db.runDerive('ClockDb','refresh',refreshClock); }
  @scheduled('1h') @job fold():void { Db.runDerive('Journal','rebuild',foldJournal); }
  @scheduled('1h') @job failFold():void { Db.runDerive('Journal','rebuild',failJournal); }
  @scheduled('1h') write():void { App.docs.upsert(new Key(42),new Value('cold')); }
}
class Handler extends ToilHandler {
  handle(req:Request):Response {
    if(req.path=='/backlog') { for(let i=0;i<5;i++) Backlog.events.append(new Key(),new Value(i.toString()));return Response.empty(204); }
    else if(req.path=='/live') { const row=ClockDb.live.get(new Key());return Response.text(row==null?'missing':row.text); }
    else if(req.path=='/events') {
      for(let i=0;i<3;i++) Journal.events.append(new Key(),new Value('event-'+i.toString()));
    } else if(req.path=='/last') {
      const row=Journal.last.get(new Key());return Response.text(row==null?'missing':row.text);
    } else if(req.path=='/write') {
      App.docs.upsert(new Key(7),new Value('first'));
      App.docs.upsert(new Key(7),new Value('second'));
      Other.docs.upsert(new Key(99),new Value('other database'));
    } else if(req.path=='/delete') App.docs.delete(new Key(7));
    else if(req.path=='/take') App.docs.getDelete(new Key(7));
    else if(req.path=='/member') App.members.add(new Key(8),new Value('member'));
    else { const row=App.report.get(new Key());return Response.text(row==null?'missing':row.text); }
    return Response.empty(204);
  }
}
Server.handler=():ToilHandler=>new Handler();
export * from 'toiljs/server/runtime/exports';
`;
beforeAll(() => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));

    for (const [out, mode] of [
        [hot, 'hot'],
        [cold, 'cold'],
    ]) {
        const selected =
            mode === 'hot'
                ? source.replace(/@daemon class Jobs \{[\s\S]*?\n\}/, '')
                : source.slice(0, source.indexOf('class Handler'));
        writeFileSync(join(root, 'app.ts'), selected);
        const result = spawnSync(
            process.execPath,
            [
                process.env.TOILSCRIPT_TEST_BIN ??
                    resolve('node_modules/toilscript/bin/toilscript.js'),
                'app.ts',
                '-o',
                out,
                '--runtime',
                'stub',
                '--memoryBase',
                '65536',
                '--targetMode',
                mode,
            ],
            { cwd: root, encoding: 'utf8' },
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
    }
});
beforeEach(() => __resetDbForTests());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const request = (path: string) => ({
    method: path === '/state' ? 'GET' : 'POST',
    path,
    query: '',
    host: 'changes.test',
    headers: [],
    body: new Uint8Array(),
});
const text = (module: WasmServerModule) =>
    new TextDecoder().decode(module.dispatch(request('/state')).body);

it('passes deduplicated source keys to real hot derives, including deletions and memberships', () => {
    const module = new WasmServerModule(hot);
    module.refresh();
    expect(text(module)).toBe('full');
    module.dispatch(request('/write'));
    expect(text(module)).toBe('App/docs:7;');
    module.dispatch(request('/take'));
    expect(text(module)).toBe('App/docs:7;');
    module.dispatch(request('/delete'));
    expect(text(module)).toBe('App/docs:7;');
    module.dispatch(request('/member'));
    expect(text(module)).toBe('App/members:8;');
});

it('passes cold task changes without waiting for a request', () => {
    const host = new DaemonHost(
        cold,
        {
            region: null,
            standbyRegion: null,
            defaultIntervalMs: 3600000,
            tickBudgetMs: 30000,
            gasTick: 0,
            maxTasks: 64,
        },
        'all',
        () => {},
    );
    try {
        host.refresh();
        expect(
            host.runTask(host.tasks.find((t) => t.name.endsWith('write'))!.name, 1234).status,
        ).toBe('ok');
        // Inspect the published value without loading another materializer.
        const module = new WasmServerModule(hot);
        module.refresh();
        // Its startup rebuild is expected to request a full rescan.
        expect(text(module)).toBe('full');
        expect(
            host.runTask(host.tasks.find((t) => t.name.endsWith('write'))!.name, 1235).status,
        ).toBe('ok');
        expect(text(module)).toBe('App/docs:42;');
    } finally {
        host.close();
    }
});

it('requires full rescan on bounded-context overflow and unknown collection mutations', () => {
    const db = freshDbState();
    db.functionKind = DbFunctionKind.Job;
    db.handles.push({
        name: 'App/docs',
        family: CollectionFamily.Record,
        schemaVersion: 0,
        replication: 0,
        placement: 0,
        fillMaxWaitMs: 0,
        fillAllowStale: false,
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const bytes = new Uint32Array(memory.buffer);
    db.writtenCollections.add('App/docs');
    for (let i = 0; i < 257; i++) {
        bytes[0] = i;
        captureDbKey(db, { memory }, [0, 0, 4]);
    }
    expect(deriveChangesFrame(db, 'App')).toEqual(Buffer.from([1, 0, 0, 0, 0]));
    const fresh = freshDbState();
    fresh.writtenCollections.add('App/docs');
    expect(deriveChangesFrame(fresh, 'App')).toEqual(Buffer.from([1, 0, 0, 0, 0]));
});

it('runs timed materializers with the named cursor and replays a trapped fold', () => {
    const module = new WasmServerModule(hot);
    module.refresh();
    module.dispatch(request('/events'));
    const last = () =>
        new TextDecoder().decode(module.dispatch({ ...request('/last'), method: 'GET' }).body);
    expect(last()).toBe('event-0');
    const host = new DaemonHost(
        cold,
        {
            region: null,
            standbyRegion: null,
            defaultIntervalMs: 3600000,
            tickBudgetMs: 30000,
            gasTick: 0,
            maxTasks: 64,
        },
        'all',
        () => {},
    );
    try {
        host.refresh();
        // Startup catches up once using the shared cursor, rather than replaying event-0.
        expect(last()).toBe('event-1');
        const fold = host.tasks.find((t) => t.name.endsWith('.fold') || t.name === 'fold')!.name;
        const fail = host.tasks.find((t) => t.name.endsWith('failFold'))!.name;
        expect(host.runTask(fail, 1234).status).toBe('trapped');
        expect(last()).toBe('event-2');
        const completed = host.runTask(fold, 1235);
        expect(completed.status).toBe('ok');
        expect(completed.budget.ops).toBe(2);
        expect(completed.budget.writes).toBe(1);
        expect(last()).toBe('event-2');
        // A later task can still enter a materializer after the preceding trap.
        expect(host.runTask(fold, 1236).status).toBe('ok');
        expect(last()).toBe('empty');
    } finally {
        host.close();
    }
});

it('refreshes a time-dependent projection without a source write', () => {
    const module = new WasmServerModule(hot);
    module.refresh();
    const live = () =>
        new TextDecoder().decode(module.dispatch({ ...request('/live'), method: 'GET' }).body);
    expect(live()).toBe('expired');
    const host = new DaemonHost(
        cold,
        {
            region: null,
            standbyRegion: null,
            defaultIntervalMs: 3600000,
            tickBudgetMs: 30000,
            gasTick: 0,
            maxTasks: 64,
        },
        'all',
        () => {},
        { clock: () => 1000 },
    );
    try {
        host.refresh();
        expect(live()).toBe('live');
        const expire = host.tasks.find((t) => t.name.endsWith('expire'))!.name;
        const result = host.runTask(expire, 3000);
        expect(result.status).toBe('ok');
        expect(result.budget.ops).toBe(1);
        expect(result.budget.writes).toBe(1);
        expect(live()).toBe('expired');
    } finally {
        host.close();
    }
});

it('drains a persisted continuation backlog on the idle scheduler without HTTP writes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    configureDbPersistence(join(root, 'continuations.json'));
    const module = new WasmServerModule(hot);
    module.refresh();
    module.dispatch(request('/backlog'));
    expect(devDb.pendingContinuations().size).toBe(1);
    // Reconstruct the store and resident worker, preserving only its disk snapshot.
    __resetDbForTests();
    configureDbPersistence(join(root, 'continuations.json'));
    const host = new DaemonHost(
        cold,
        {
            region: null,
            standbyRegion: null,
            defaultIntervalMs: 3600000,
            tickBudgetMs: 30000,
            gasTick: 0,
            maxTasks: 64,
        },
        'all',
        () => {},
    );
    try {
        host.refresh();
        expect(host.callI32Export('backlogValue')).toBe(1);
        expect(host.callI32Export('continuationBudget')).toBe(3);
        await vi.advanceTimersByTimeAsync(4000);
        expect(host.callI32Export('backlogValue')).toBe(4);
        expect(devDb.pendingContinuations().size).toBe(0);
    } finally {
        host.close();
        vi.useRealTimers();
    }
});

it('rejects a continuation build without its matching resident materializers', () => {
    expect(() => validateDeriveContinuationArtifacts(readFileSync(hot), null)).toThrow(
        /resident @daemon/,
    );
    const empty = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    expect(() => validateDeriveContinuationArtifacts(readFileSync(hot), empty)).toThrow(
        /resident @daemon/,
    );
    expect(() =>
        validateDeriveContinuationArtifacts(readFileSync(hot), readFileSync(cold)),
    ).not.toThrow();
});

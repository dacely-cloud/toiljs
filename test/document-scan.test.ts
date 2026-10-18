import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { DaemonHost } from '../src/devserver/daemon/index.js';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { __resetDbForTests } from '../src/devserver/db/index.js';

const root = mkdtempSync(join(tmpdir(), 'toil-document-scan-'));
const shared = `
@data class Key { id:i32=0; constructor(id:i32=0){this.id=id;} }
@data class Value { text:string=''; constructor(text:string=''){this.text=text;} }
@database class App {
  @collection static docs:Documents<Key,Value>;
  @collection static other:Documents<Key,Value>;
  @collection static report:View<Key,Value>;
}
`;
function compile(name: string, source: string, mode: string) {
    writeFileSync(join(root, name + '.ts'), shared + source);
    return spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ?? resolve('node_modules/toilscript/bin/toilscript.js'),
            name + '.ts',
            '-o',
            join(root, name + '.wasm'),
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
            '--targetMode',
            mode,
        ],
        { cwd: root, encoding: 'utf8' },
    );
}
beforeAll(() => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
    const hot = compile(
        'hot',
        `
import { Server, Response, Request, ToilHandler } from 'toiljs/server/runtime';
class Handler extends ToilHandler {
  handle(req:Request):Response {
    if(req.path=='/seed') {
      for(let i=0;i<25;i++) App.docs.upsert(new Key(i),new Value('row-'+i.toString()));
      App.other.upsert(new Key(777),new Value('private'));
      return Response.empty(204);
    }
    if(req.path=='/other')return Response.text(App.other.require(new Key(777)).text);
    const report=App.report.get(new Key());return Response.text(report==null?'pending':report.text);
  }
}
Server.handler=():ToilHandler=>new Handler();
export * from 'toiljs/server/runtime/exports';
`,
        'hot',
    );
    expect(hot.status, hot.stdout + hot.stderr).toBe(0);
    const cold = compile(
        'cold',
        `
let cursor:Uint8Array|null=null;
let count:i32=0;
let finished:bool=false;
@daemon class Cleanup {
  @scheduled('1h') @job clean():void {
    if(finished)return;
    const page=App.docs.scan(3,cursor);
    for(let i=0;i<page.entries.length;i++) {
      const entry=page.entries[i];
      if(entry.value.text!='row-'+entry.key.id.toString())throw new Error('wrong key/value');
      if(!App.docs.compareDeleteSnapshot(entry.key,entry.snapshot))throw new Error('stale scan');
      count++;
    }
    cursor=page.cursor;finished=cursor==null;
    const b=Db.budget();
    if(b.writes><u32>page.entries.length)throw new Error('scan charged a write');
    App.report.publish(new Key(),new Value((finished?'done:':'page:')+count.toString()));
  }
}
`,
        'cold',
    );
    expect(cold.status, cold.stdout + cold.stderr).toBe(0);
});
beforeEach(() => __resetDbForTests());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const req = (path: string) => ({
    method: path === '/seed' ? 'POST' : 'GET',
    path,
    headers: [],
    body: new Uint8Array(),
});
it('walks and conditionally deletes typed documents from real background Wasm', () => {
    const hot = new WasmServerModule(join(root, 'hot.wasm'));
    hot.refresh();
    hot.dispatch(req('/seed'));
    const host = new DaemonHost(
        join(root, 'cold.wasm'),
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
        const task = host.tasks.find((t) => t.name.endsWith('clean'))!;
        let done = false;
        for (let i = 0; i < 150; i++) {
            expect(host.runTask(task.name, 1000 + i).status).toBe('ok');
            const state = new TextDecoder().decode(hot.dispatch(req('/state')).body);
            if (state.startsWith('done:')) {
                expect(state).toBe('done:25');
                done = true;
                break;
            }
        }
        expect(done).toBe(true);
        expect(new TextDecoder().decode(hot.dispatch(req('/other')).body)).toBe('private');
    } finally {
        host.close();
    }
});
it.each(['query', 'action'])('rejects document scans from @%s at compile time', (kind) => {
    const result = compile(
        'bad-' + kind,
        `@${kind} export function bad():void { App.docs.scan(1); }`,
        'cold',
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/may not call '.scan'|cannot scan/i);
});

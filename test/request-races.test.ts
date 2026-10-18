import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WasmServerModule } from '../src/devserver/runtime/module.js';
import { __resetDbForTests } from '../src/devserver/db/index.js';

const root = mkdtempSync(join(tmpdir(), 'toil-request-races-'));
const out = join(root, 'app.wasm');
let module: WasmServerModule;
const request = (path: string) => ({
    method: path === '/state' ? 'GET' : 'POST',
    path,
    headers: [['host', 'localhost']] as [string, string][],
    body: new Uint8Array(0),
});
const barrier = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
};

beforeAll(() => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(resolve('.'), join(root, 'node_modules/toiljs'));
    writeFileSync(
        join(root, 'app.ts'),
        `
import {Server,Request,Response,ToilHandler} from 'toiljs/server/runtime';
@data class Key { id:i32=1; }
@data class Value { n:i32=1; }
@database class App { @collection static docs:Documents<Key,Value>; }
class Handler extends ToilHandler {
  handle(req:Request):Response {
    const key=new Key();
    if(req.path=='/trap'){const value=new Value();value.n=99;App.docs.upsert(key,value);throw new Error('after write');}
    if(req.path=='/seed'){App.docs.upsert(key,new Value());return Response.empty(204);}
    if(req.path=='/delete'){App.docs.delete(key);return Response.empty(204);}
    if(req.path=='/increment'){
      const observed=App.docs.getCurrentSnapshot(key);
      if(observed==null)return Response.notFound();
      const next=new Value();next.n=observed.value.n+1;
      return Response.empty(App.docs.compareExchangeSnapshot(key,observed,next)?200:409);
    }
    const value=App.docs.get(key);
    return value==null?Response.notFound():Response.text(value.n.toString());
  }
}
Server.handler=():ToilHandler=>new Handler();
export * from 'toiljs/server/runtime/exports';
`,
    );
    const result = spawnSync(
        process.execPath,
        [
            resolve('node_modules/toilscript/bin/toilscript.js'),
            'app.ts',
            '-o',
            out,
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
        ],
        { cwd: root, encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
});
beforeEach(() => {
    __resetDbForTests();
    module = new WasmServerModule(out);
    module.refresh();
    expect(module.dispatch(request('/seed')).status).toBe(204);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const jspi = typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending === 'function';

describe.skipIf(!jspi)('deterministic real-Wasm request interleavings', () => {
    it('pauses a caller-observed write while another request deletes the row', async () => {
        const reached = barrier(),
            resume = barrier();
        const increment = module.dispatchAsync(request('/increment'), {
            beforeDatabaseOperation: async (point) => {
                if (point.operation !== 'data.compare_exchange') return;
                expect(point.collection).toBe('App/docs');
                expect(point.key?.length).toBeGreaterThan(0);
                reached.release();
                await resume.promise;
            },
        });
        await reached.promise;
        expect((await module.dispatchAsync(request('/delete'))).status).toBe(204);
        resume.release();
        expect((await increment).status).toBe(409);
        expect(module.dispatch(request('/state')).status).toBe(404);
    });
    it('overlaps two read-modify-write requests and commits exactly one CAS', async () => {
        const firstReady = barrier(),
            secondReady = barrier(),
            resumeFirst = barrier(),
            resumeSecond = barrier();
        const paused = (ready: ReturnType<typeof barrier>, resume: ReturnType<typeof barrier>) =>
            module.dispatchAsync(request('/increment'), {
                beforeDatabaseOperation: async (point) => {
                    if (point.operation === 'data.compare_exchange') {
                        ready.release();
                        await resume.promise;
                    }
                },
            });
        const first = paused(firstReady, resumeFirst),
            second = paused(secondReady, resumeSecond);
        await Promise.all([firstReady.promise, secondReady.promise]);
        resumeFirst.release();
        expect((await first).status).toBe(200);
        resumeSecond.release();
        expect((await second).status).toBe(409);
        expect(new TextDecoder().decode(module.dispatch(request('/state')).body)).toBe('2');
    });
});

it('preserves completed dev-host writes when a later guest operation traps', () => {
    expect(() => module.dispatch(request('/trap'))).toThrow(/after write/);
    expect(new TextDecoder().decode(module.dispatch(request('/state')).body)).toBe('99');
});

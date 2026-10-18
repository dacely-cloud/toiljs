import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonHost } from '../src/devserver/daemon/index.js';
import type { DaemonHttpRequest } from '../src/devserver/daemon/http.js';
import { freshDaemonState, buildDaemonImports } from '../src/devserver/daemon/host.js';

const root = mkdtempSync(join(tmpdir(), 'toil-daemon-api-'));
const wasm = join(root, 'daemon.wasm');
const cfg = {
    region: null,
    standbyRegion: null,
    defaultIntervalMs: 3600000,
    tickBudgetMs: 30000,
    gasTick: 0,
    maxTasks: 64,
};
beforeAll(() => {
    const app = join(root, 'daemon.ts');
    writeFileSync(
        app,
        `
let observed: i64 = 0;
let starts: i32 = 0;
let startupOps: i32 = 0;
@data class StartKey { id:i32=0; }
@data class StartValue { n:i32=0; }
@database class Startup {
  @collection static members: Membership<StartKey, StartValue>;
  @collection static ready: View<StartKey, StartValue>;
}
@daemon class Jobs {
  @job onStart():void {
    starts++;
    startupOps=<i32>Db.budget().maxOps;
    Startup.members.list(new StartKey(),1);
    Startup.ready.publish(new StartKey(),new StartValue());
  }
  @scheduled('1h') fetchPrice(): void {
    observed = Date.now();
    const request = new DaemonHttpRequest('POST', 'https://prices.example/fish').header('accept', 'application/json');
    request.body = Uint8Array.wrap(String.UTF8.encode('fish'));
    const response = Daemon.httpCall(request);
    if (response == null || response.status != 201 || response.text() != 'fresh') throw new Error('transport failed');
  }
  @scheduled('1h') fail(): void { throw new Error('intentional task failure'); }
}
export function startCount():i32 { return starts; }
export function startupMaxOps():i32 { return startupOps; }
export function observedLow(): i32 { return <i32>observed; }
`,
    );
    const result = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ?? resolve('node_modules/toilscript/bin/toilscript.js'),
            app,
            '-o',
            wasm,
            '--runtime',
            'stub',
            '--targetMode',
            'cold',
        ],
        { encoding: 'utf8' },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('supported daemon testing API', () => {
    it('runs named tasks at an isolated clock and returns failures as structured results', () => {
        let clock = 1234;
        const requests: DaemonHttpRequest[] = [];
        const host = new DaemonHost(wasm, cfg, 'all', () => {}, {
            clock: () => clock,
            httpMock: (request) => {
                requests.push(request);
                return { status: 201, body: new TextEncoder().encode('fresh') };
            },
        });
        const originalNow = Date.now;
        try {
            host.refresh();
            expect(host.active).toBe(true);
            expect(host.callI32Export('startCount')).toBe(1);
            expect(host.callI32Export('startupMaxOps')).toBe(65535);
            host.refresh();
            expect(host.callI32Export('startCount')).toBe(1);
            const fetch = host.tasks.find((task) => task.name.endsWith('fetchPrice'))!.name;
            const fail = host.tasks.find((task) => task.name.endsWith('fail'))!.name;
            const result = host.runTask(fetch, 1700000000123);
            expect(result.status).toBe('ok');
            expect(result.returnCode).toBe(0n);
            expect(result.atMillis).toBe(1700000000123);
            expect(result.budget.maxOps).toBe(64);
            expect(host.callI32Export('observedLow')).toBe(1700000000123 | 0);
            expect(Date.now).toBe(originalNow);
            expect(requests).toHaveLength(1);
            expect(requests[0].url).toBe('https://prices.example/fish');
            expect(requests[0].headers).toEqual([['accept', 'application/json']]);
            expect(new TextDecoder().decode(requests[0].body)).toBe('fish');
            clock = 9876;
            expect(host.runTask(fetch).status).toBe('ok');
            expect(host.callI32Export('observedLow')).toBe(clock);
            const failure = host.runTask(fail, 100);
            expect(failure.status).toBe('trapped');
            expect(failure.error).toMatch(/intentional task failure/);
            expect(host.runTask('missing', 100).status).toBe('not-found');
            expect(() => host.runTask(fetch, NaN)).toThrow(/atMillis/);
        } finally {
            host.close();
        }
    });
    it('keeps native buffer and malformed-request behavior on the mock seam', () => {
        const memory = new WebAssembly.Memory({ initial: 1 });
        const rt = {
            isLeader: () => true,
            epoch: () => 1n,
            taskCount: () => 0,
            nextFireMs: () => null,
            httpMock: () => ({ status: 200, body: new Uint8Array(10) }),
        };
        const call = (
            buildDaemonImports({ memory }, freshDaemonState(), rt).daemon as Record<
                string,
                (...args: number[]) => bigint
            >
        ).http_call;
        expect(call(0, 0, 1024, 64)).toBe(-BigInt(0x10000 + 0x0405));
        expect(() => call(65535, 2, 0, 64)).toThrow(/memory range/);
        const req = Buffer.concat([
            Buffer.from([3]),
            Buffer.from('GET'),
            Buffer.from([18, 0]),
            Buffer.from('https://prices.dev'),
            Buffer.alloc(6),
        ]);
        new Uint8Array(memory.buffer).set(req);
        expect(call(0, req.length, 1024, 1)).toBe(-1n);
        expect(call(0, req.length, 1024, 64)).toBe(18n);
    });
});

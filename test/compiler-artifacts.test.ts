import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildServer } from '../src/compiler/index.js';

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('isolates real tier WAT, source maps, bindings and editor types, and reuses each tier independently', async () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'toil-artifacts-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(
        path.resolve('node_modules/toilscript'),
        path.join(root, 'node_modules/toilscript'),
        'dir',
    );
    fs.mkdirSync(path.join(root, 'server'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(
        path.join(root, 'toilconfig.json'),
        JSON.stringify({
            entries: ['server/main.ts'],
            targets: {
                release: {
                    outFile: 'build/server/release.wasm',
                    textFile: 'build/server/release.wat',
                },
            },
            options: {
                runtime: 'stub',
                sourceMap: true,
                bindings: ['esm'],
                optimizeLevel: 0,
                shrinkLevel: 0,
            },
        }),
    );
    fs.writeFileSync(
        path.join(root, 'server/main.ts'),
        'export function handle(ofs:i32,len:i32):i64 { return 0; }',
    );
    fs.writeFileSync(
        path.join(root, 'server/jobs.ts'),
        '@daemon class Jobs { @scheduled("1h") tick():void {} }',
    );
    fs.copyFileSync(
        path.resolve('test/fixtures/stream-echo.ts'),
        path.join(root, 'server/main.stream.ts'),
    );
    const file = (name: string) => path.join(root, 'build/server', name);

    await buildServer(root);
    for (const [stem, tier, symbol] of [
        ['release', 'request', 'handle'],
        ['release-cold', 'cold', 'scheduled_tick'],
        ['release-stream', 'stream', 'stream_dispatch'],
    ]) {
        expect(fs.readFileSync(file(stem + '.wat'), 'utf8')).toContain(`(export "${symbol}"`);
        expect(fs.existsSync(file(stem + '.wasm.map'))).toBe(true);
        expect(fs.existsSync(file(stem + '.js'))).toBe(true);
        expect(fs.readFileSync(file(stem + '.d.ts'), 'utf8')).toContain(symbol);
        expect(fs.existsSync(path.join(root, 'server', `toilscript.${tier}.generated.d.ts`))).toBe(
            true,
        );
    }
    expect(fs.readFileSync(path.join(root, 'shared/server.ts'), 'utf8')).toContain('Echo');
    const snapshot = () =>
        new Map(
            fs
                .readdirSync(path.join(root, 'build/server'))
                .map((name) => [name, fs.statSync(file(name), { bigint: true }).mtimeNs]),
        );
    const before = snapshot();
    await buildServer(root);
    expect(snapshot()).toEqual(before);
    fs.rmSync(file('release-cold.wat'));
    await buildServer(root);
    const after = snapshot();
    expect(after.get('release-cold.wasm')).not.toBe(before.get('release-cold.wasm'));
    expect(after.get('release.wasm')).toBe(before.get('release.wasm'));
    expect(after.get('release-stream.wasm')).toBe(before.get('release-stream.wasm'));
}, 30000);

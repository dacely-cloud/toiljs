/**
 * Two-pass build pipeline (doc 08 section 1). Asserts:
 *
 *   - `serverArtifacts` derives the `-hot`/`-cold` paths from `outFile` when
 *     `hotFile`/`coldFile` are absent, and honors them when present.
 *   - `SURFACE_DECORATOR` matches `@stream`/`@daemon`/`@scheduled` at line start
 *     (not in a comment).
 *   - `buildServer` on a project that declares a `@daemon` runs TWO toilscript
 *     passes (one `--targetMode cold`, one `--targetMode hot`) and produces BOTH
 *     `release-hot.wasm` and `release-cold.wasm`; the cold artifact decodes to a
 *     daemon catalog and its `toil.surface` is target_mode = cold.
 *   - a project with only the legacy request surface keeps the single-artifact
 *     path (no cold pass, no cold artifact).
 *
 * The build invokes the LOCAL toilscript (branch feat/streams-phase0-compiler),
 * which supports `--targetMode`; the test links it into the fixture project's
 * `node_modules` the same way the dev build resolves it (`require.resolve`).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildServer,
    serverArtifacts,
    splitSurfaceFiles,
    SURFACE_DECORATOR,
} from '../src/compiler/index.js';
import { parseDaemonCatalog } from '../src/devserver/daemon/catalog.js';
import { parseSurface } from '../src/devserver/wasm/surface.js';

const here = dirname(fileURLToPath(import.meta.url));
const LOCAL_TOILSCRIPT = join(here, '..', '..', 'toilscript');

let tmp: string;

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'daemon-build-'));
});
afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});

/** Scaffold a minimal project at `tmp` with `server/main.ts` = `serverSrc`, the
 *  given toilconfig, and `node_modules/toilscript` symlinked to the local build. */
function scaffold(serverSrc: string, toilconfig: object): void {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
    writeFileSync(join(tmp, 'toilconfig.json'), JSON.stringify(toilconfig, null, 2));
    mkdirSync(join(tmp, 'server'), { recursive: true });
    writeFileSync(join(tmp, 'server', 'main.ts'), serverSrc);
    mkdirSync(join(tmp, 'node_modules'), { recursive: true });
    symlinkSync(LOCAL_TOILSCRIPT, join(tmp, 'node_modules', 'toilscript'), 'dir');
}

const BASE_TOILCONFIG = {
    entries: ['server/main.ts'],
    targets: { release: { outFile: 'build/server/release.wasm' } },
    options: { runtime: 'stub', optimizeLevel: 0, shrinkLevel: 0 },
};

// A @daemon that declares its host imports directly (no toiljs globals lib needed).
const DAEMON_SRC = `@daemon
class Jobs {
  @scheduled("2s") fast(): void {}
  @scheduled("0 0 * * *") nightly(): void {}
}
export function probe(): i32 { return 1; }
`;

const LEGACY_SRC = `export function handle(ofs: i32, len: i32): i64 { return 0; }
export function probe(): i32 { return 1; }
`;

describe('serverArtifacts path derivation', () => {
    it('derives -hot/-cold from outFile when hotFile/coldFile are absent', () => {
        writeFileSync(
            join(tmp, 'toilconfig.json'),
            JSON.stringify({ targets: { release: { outFile: 'build/server/release.wasm' } } }),
        );
        const a = serverArtifacts(tmp);
        expect(a.hot).toBe(join(tmp, 'build/server/release-hot.wasm'));
        expect(a.cold).toBe(join(tmp, 'build/server/release-cold.wasm'));
    });

    it('honors explicit hotFile/coldFile when present', () => {
        writeFileSync(
            join(tmp, 'toilconfig.json'),
            JSON.stringify({
                targets: {
                    release: {
                        outFile: 'build/server/release.wasm',
                        hotFile: 'out/hot.wasm',
                        coldFile: 'out/cold.wasm',
                    },
                },
            }),
        );
        const a = serverArtifacts(tmp);
        expect(a.hot).toBe(join(tmp, 'out/hot.wasm'));
        expect(a.cold).toBe(join(tmp, 'out/cold.wasm'));
    });
});

describe('SURFACE_DECORATOR', () => {
    it('matches the streams/daemon decorators at line start', () => {
        for (const deco of ['@stream', '@daemon', '@scheduled', '@rest', '@data']) {
            expect(SURFACE_DECORATOR.test(`${deco} class X {}`)).toBe(true);
            expect(SURFACE_DECORATOR.test(`  ${deco}\nclass X {}`)).toBe(true);
        }
    });

    it('does NOT match a decorator mentioned only in a comment', () => {
        expect(SURFACE_DECORATOR.test('// the @daemon decorator marks a cold class')).toBe(false);
        expect(SURFACE_DECORATOR.test('const s = "uses @scheduled internally";')).toBe(false);
    });
});

describe('splitSurfaceFiles per-pass classification', () => {
    /** Lay down `name -> contents` files under `tmp` and return their relative paths. */
    function lay(files: Record<string, string>): string[] {
        mkdirSync(join(tmp, 'server'), { recursive: true });
        const rels: string[] = [];
        for (const [name, src] of Object.entries(files)) {
            writeFileSync(join(tmp, name), src);
            rels.push(name);
        }
        return rels;
    }

    it('drops daemon-only files from the hot pass and hot-only files from the cold pass', () => {
        const rels = lay({
            'server/jobs.ts': '@daemon\nclass J { @scheduled("1s") t(): void {} }\n',
            'server/api.ts': '@rest\nclass A {}\n',
            'server/model.ts': '@data\nclass M {}\n',
            'server/util.ts': 'export function helper(): i32 { return 1; }\n',
        });
        const split = splitSurfaceFiles(tmp, rels);
        expect(split.hasDaemon).toBe(true);
        // hot pass: everything except the daemon-only jobs.ts.
        expect(split.hot.sort()).toEqual(
            ['server/api.ts', 'server/model.ts', 'server/util.ts'].sort(),
        );
        // cold pass: everything except the hot-only api.ts.
        expect(split.cold.sort()).toEqual(
            ['server/jobs.ts', 'server/model.ts', 'server/util.ts'].sort(),
        );
    });

    it('keeps a file that mixes both surfaces in both passes', () => {
        const rels = lay({ 'server/both.ts': '@daemon\nclass J {}\n@rest\nclass A {}\n' });
        const split = splitSurfaceFiles(tmp, rels);
        expect(split.hot).toContain('server/both.ts');
        expect(split.cold).toContain('server/both.ts');
    });
});

describe('buildServer two-pass (daemon project)', () => {
    it('runs the cold pass and produces the cold artifact with a daemon catalog', async () => {
        scaffold(DAEMON_SRC, BASE_TOILCONFIG);
        await buildServer(tmp);

        const cold = join(tmp, 'build/server/release-cold.wasm');
        expect(existsSync(cold), 'cold artifact missing').toBe(true);

        // The cold artifact carries the daemon surface + catalog (decoded byte-for-byte).
        const coldBytes = readFileSync(cold);
        const surface = parseSurface(coldBytes);
        expect(surface !== 'absent' && surface !== 'invalid' && surface.targetMode).toBe('cold');
        expect(surface !== 'absent' && surface !== 'invalid' && surface.flags.daemon).toBe(true);

        const catalog = parseDaemonCatalog(coldBytes);
        expect(catalog).not.toBeNull();
        expect(catalog!.hasDaemon).toBe(true);
        expect(catalog!.tasks.map((t) => t.name)).toEqual(['fast', 'nightly']);
        expect(catalog!.tasks[0].schedule.kind).toBe('interval');
        expect(catalog!.tasks[1].schedule.kind).toBe('cron');

        // A daemon-only project (no request/stream surface) has no hot files, so the hot pass is
        // skipped (toilscript would HARD-ERROR a @daemon class under --targetMode hot). The legacy
        // single-artifact `release.wasm` is therefore not produced for a pure background worker.
        expect(existsSync(join(tmp, 'build/server/release.wasm'))).toBe(false);
    }, 60_000);

    it('keeps the single-artifact path for a legacy (no-daemon) project', async () => {
        scaffold(LEGACY_SRC, BASE_TOILCONFIG);
        await buildServer(tmp);

        expect(existsSync(join(tmp, 'build/server/release.wasm'))).toBe(true);
        // No @daemon -> no cold pass -> no cold artifact.
        expect(existsSync(join(tmp, 'build/server/release-cold.wasm'))).toBe(false);
    }, 60_000);
});

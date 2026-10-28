import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    runCompilerPasses,
    type CompilerPass,
    type CompilerBuildOptions,
} from '../src/compiler/compiler-build.js';
import { withCompilerLock } from '../src/compiler/compiler-lock.js';

let root: string;
let bin: string;
const active = new Set<Promise<void>>();
const cancellations = new Set<AbortController>();

beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'toil-compiler-build-'));
    for (const dir of ['compiler/bin', 'compiler/dist', 'control', 'library', 'build'])
        fs.mkdirSync(join(root, dir), { recursive: true });
    fs.writeFileSync(join(root, 'compiler/package.json'), '{"type":"module"}');
    bin = join(root, 'compiler/bin/toilscript.js');
    fs.writeFileSync(
        bin,
        `import fs from 'node:fs'; import path from 'node:path';
import {main} from '../dist/cli.js';
const result = await main(process.argv.slice(2), {
    async readFile(file, base) { try { return fs.readFileSync(path.resolve(base,file),'utf8'); } catch { return null; } },
    listFiles(dir, base) { return fs.readdirSync(path.resolve(base,dir)).filter(name=>name.endsWith('.ts')); },
    async writeFile(file, contents, base) { const full=path.resolve(base,file); fs.mkdirSync(path.dirname(full),{recursive:true}); fs.writeFileSync(full,contents); return true; }
}); if(result.error) process.exitCode=1;
`,
    );
    fs.copyFileSync(resolve('test/fixtures/compiler-cli.mjs'), join(root, 'compiler/dist/cli.js'));
    fs.writeFileSync(join(root, 'toilconfig.json'), '{}');
    fs.writeFileSync(join(root, 'input.ts'), 'alpha');
    fs.writeFileSync(join(root, 'library/base.ts'), 'base');
});

afterEach(async () => {
    for (const controller of cancellations) controller.abort();
    await Promise.allSettled([...active]);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
});

function pass(name = 'request', ...flags: string[]): CompilerPass {
    return { name, args: ['--name', name, '--outFile', join(root, 'build', name), ...flags] };
}

function run(passes = [pass()], options: CompilerBuildOptions = {}) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    cancellations.add(controller);
    const building = withCompilerLock(root, () =>
        runCompilerPasses(root, bin, passes, () => {}, { ...options, signal: controller.signal }),
    );
    active.add(building);
    const clear = () => {
        active.delete(building);
        cancellations.delete(controller);
        options.signal?.removeEventListener('abort', cancel);
    };
    void building.then(clear, clear);
    return building;
}

function output(name = 'request'): string {
    return fs.readFileSync(join(root, 'build', name), 'utf8');
}

function calls(): number {
    return fs.readFileSync(join(root, 'control/calls'), 'utf8').trim().split('\n').length;
}

async function ready(name: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(join(root, 'control', name + '.ready'))) {
        if (Date.now() > deadline) throw new Error(`Compiler fixture did not reach ${name}`);
        await setTimeout(10);
    }
}

function clean(): void {
    const files = fs.readdirSync(join(root, '.toil/compiler'));
    expect(files.some((file) => file.startsWith('pending-') || file.startsWith('lock'))).toBe(
        false,
    );
}

describe('isolated tier compilation', () => {
    it.skipIf(availableParallelism() < 2)(
        'runs independent tiers concurrently and publishes only after the complete generation validates',
        async () => {
            fs.writeFileSync(join(root, 'build/cold'), 'old cold');
            fs.writeFileSync(join(root, 'build/request'), 'old request');
            const validated = vi.fn((read: (file: string) => Buffer) => {
                expect(read(join(root, 'build/request')).toString()).toContain('alpha');
                expect(output('request')).toBe('old request');
            });
            const building = run([pass('cold', '--hold'), pass('request', '--hold')], {
                validate: validated,
            });
            try {
                await Promise.all([ready('cold'), ready('request')]);
                expect(output('cold')).toBe('old cold');
                expect(output()).toBe('old request');
                fs.writeFileSync(join(root, 'control/cold.release'), '');
                fs.writeFileSync(join(root, 'control/request.release'), '');
                await building;
                expect(validated).toHaveBeenCalledOnce();
                expect(output('cold')).toContain('alpha');
                expect(output()).toContain('alpha');
                clean();
            } finally {
                fs.writeFileSync(join(root, 'control/cold.release'), '');
                fs.writeFileSync(join(root, 'control/request.release'), '');
                await building.catch(() => {});
            }
        },
    );

    it('keeps previous artifacts on validation failure and drains failed/cancelled siblings', async () => {
        fs.writeFileSync(join(root, 'build/request'), 'old');
        await expect(
            run([pass()], {
                validate: () => {
                    throw new Error('invalid generation');
                },
            }),
        ).rejects.toThrow('invalid generation');
        expect(output()).toBe('old');
        clean();
        if (availableParallelism() >= 2) {
            const building = run([pass('cold', '--hold'), pass('request', '--hold', '--fail')]);
            const rejected = expect(building).rejects.toThrow('build failed');
            await Promise.all([ready('cold'), ready('request')]);
            fs.writeFileSync(join(root, 'control/request.release'), '');
            await rejected;
            const pid = Number(fs.readFileSync(join(root, 'control/cold.started'), 'utf8'));
            expect(() => process.kill(pid, 0)).toThrow();
        } else {
            await expect(run([pass('request', '--fail')])).rejects.toThrow('build failed');
        }
        expect(output()).toBe('old');
        clean();
    });

    it('cancels and closes a launched compiler before rejecting or releasing its root lock', async () => {
        const abort = new AbortController();
        const building = run([pass('request', '--hold')], { signal: abort.signal });
        const rejected = expect(building).rejects.toThrow();
        await ready('request');
        const pid = Number(fs.readFileSync(join(root, 'control/request.started'), 'utf8'));
        abort.abort();
        await rejected;
        expect(() => process.kill(pid, 0)).toThrow();
        expect(fs.existsSync(join(root, 'build/request'))).toBe(false);
        clean();
    });

    it('rejects colliding output paths before publishing any bytes', async () => {
        fs.writeFileSync(join(root, 'build/request'), 'old');
        const cold = pass('cold');
        const request = pass();
        const colliding = {
            ...cold,
            args: ['--name', 'cold', '--outFile', join(root, 'build/request')],
        };
        await expect(run([colliding, request])).rejects.toThrow('share an output path');
        expect(output()).toBe('old');
        clean();
    });

    it('does not publish or cache inputs edited while a compiler is running', async () => {
        const building = run([pass('request', '--hold')]);
        const rejected = expect(building).rejects.toThrow('inputs changed');
        await ready('request');
        fs.writeFileSync(join(root, 'input.ts'), 'bravo');
        fs.writeFileSync(join(root, 'control/request.release'), '');
        await rejected;
        expect(fs.existsSync(join(root, 'build/request'))).toBe(false);
        await run();
        expect(output()).toContain('bravo');
        expect(calls()).toBe(2);
        clean();
    });

    it('rechecks a cached sibling when its output changes during another tier compile', async () => {
        await run();
        const building = run([pass('cold', '--hold'), pass('request')]);
        const rejected = expect(building).rejects.toThrow('outputs changed');
        await ready('cold');
        fs.writeFileSync(join(root, 'build/request'), 'changed while building');
        fs.writeFileSync(join(root, 'control/cold.release'), '');
        await rejected;
        expect(fs.existsSync(join(root, 'build/cold'))).toBe(false);
        await run();
        expect(output()).toContain('alpha');
        clean();
    });
});

describe('compiler cache correctness', () => {
    it('allows a forced recompile without disabling output isolation', async () => {
        vi.stubEnv('TOILJS_BUILD_CACHE', '0');
        await run();
        await run();
        expect(calls()).toBe(2);
        expect(fs.existsSync(join(root, '.toil/compiler/request.json'))).toBe(false);
        clean();
    });
    it('reuses verified outputs, invalidates actual dependencies, and repairs missing/corrupt artifacts', async () => {
        await run();
        await run();
        expect(calls()).toBe(1);
        const oldTime = fs.statSync(join(root, 'input.ts'));
        fs.writeFileSync(join(root, 'input.ts'), 'bravo');
        fs.utimesSync(join(root, 'input.ts'), oldTime.atime, oldTime.mtime);
        await run();
        expect(output()).toContain('bravo');
        expect(calls()).toBe(2);
        fs.writeFileSync(join(root, 'optional.ts'), 'new resolution');
        await run();
        expect(output()).toContain('new resolution');
        fs.writeFileSync(join(root, 'library/extra.ts'), 'extra');
        await run();
        expect(output()).toContain('extra');
        fs.writeFileSync(join(root, 'build/request'), 'corrupt');
        await run();
        expect(output()).toContain('bravo');
        fs.rmSync(join(root, 'build/request'));
        await run();
        expect(output()).toContain('bravo');
        fs.writeFileSync(join(root, '.toil/compiler/request.json'), '{incomplete');
        await run();
        expect(calls()).toBe(7);
        fs.appendFileSync(
            join(root, 'compiler/dist/cli.js'),
            '\n// changed compiler, same package version\n',
        );
        await run();
        expect(calls()).toBe(8);
        clean();
    });

    it('explains content-based misses without rebuilding on timestamp-only edits', async () => {
        vi.stubEnv('TOILJS_BUILD_CACHE_DEBUG', '1');
        const outputLog = vi.spyOn(process.stdout, 'write');
        await run();
        await run();
        expect(calls()).toBe(1);
        expect(
            outputLog.mock.calls.some(([value]) =>
                String(value).includes('server cache request: hit'),
            ),
        ).toBe(true);
        fs.writeFileSync(join(root, 'input.ts'), 'changed');
        await run();
        expect(calls()).toBe(2);
        expect(
            outputLog.mock.calls.some(([value]) =>
                String(value).includes('input changed: ' + join(root, 'input.ts')),
            ),
        ).toBe(true);
    });

    it('does not cache custom transforms or extended configs with untracked side effects', async () => {
        for (const config of [
            { options: { transform: ['./custom.mjs'] } },
            { extends: './base.json' },
        ]) {
            fs.writeFileSync(join(root, 'toilconfig.json'), JSON.stringify(config));
            await run();
            await run();
        }
        expect(calls()).toBe(4);
        expect(fs.existsSync(join(root, '.toil/compiler/request.json'))).toBe(false);
        clean();
    });
});

describe('compiler generation locks', () => {
    it('cleans up an incomplete lock record after an I/O failure and releases the local queue', async () => {
        vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
            throw new Error('simulated lock write failure');
        });
        await expect(withCompilerLock(root, () => Promise.resolve('unused'))).rejects.toThrow(
            'lock write failure',
        );
        expect(fs.existsSync(join(root, '.toil/compiler/lock'))).toBe(false);
        await expect(withCompilerLock(root, () => Promise.resolve('next build'))).resolves.toBe(
            'next build',
        );
        clean();
    });
    it('honors a one-job budget and never starts the next tier while the first is still running', async () => {
        vi.stubEnv('TOILJS_BUILD_JOBS', '1');
        const building = run([pass('cold', '--hold'), pass('request')]);
        await ready('cold');
        await setTimeout(30);
        expect(fs.existsSync(join(root, 'control/request.started'))).toBe(false);
        fs.writeFileSync(join(root, 'control/cold.release'), '');
        await building;
        expect(output('cold')).toContain('alpha');
        expect(output()).toContain('alpha');
        clean();
    });
    it('serializes same-root builds and recovers a dead owner without retaining temporary outputs', async () => {
        const first = run([pass('request', '--hold')]);
        await ready('request');
        const second = run();
        await setTimeout(30);
        expect(calls()).toBe(1);
        fs.writeFileSync(join(root, 'control/request.release'), '');
        await Promise.all([first, second]);
        expect(calls()).toBe(2); // Different invocation flags invalidate the first entry.
        const dead = spawnSync(process.execPath, ['-e', '']);
        fs.writeFileSync(
            join(root, '.toil/compiler/lock'),
            JSON.stringify({ pid: dead.pid, token: 'dead' }),
        );
        const abandoned = join(root, `.toil/compiler/pending-${dead.pid}-abandoned`);
        fs.mkdirSync(abandoned);
        fs.writeFileSync(join(abandoned, 'partial-output'), 'partial');
        await run();
        expect(fs.existsSync(abandoned)).toBe(false);
        clean();
    });

    it('excludes a second process from publishing into the same root', async () => {
        const lockModule = resolve('src/compiler/compiler-lock.ts');
        const code = `import {withCompilerLock} from ${JSON.stringify(lockModule)};
import fs from 'node:fs'; import {setTimeout} from 'node:timers/promises';
await withCompilerLock(process.argv[1], async()=>{
fs.writeFileSync(process.argv[1]+'/control/other.ready','');
while(!fs.existsSync(process.argv[1]+'/control/other.release')) await setTimeout(10);
});`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code, root], {
            stdio: 'inherit',
        });
        const exited = new Promise<void>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', (code) =>
                code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`)),
            );
        });
        try {
            await ready('other');
            const building = run();
            await setTimeout(50);
            expect(fs.existsSync(join(root, 'control/request.started'))).toBe(false);
            fs.writeFileSync(join(root, 'control/other.release'), '');
            await Promise.all([exited, building]);
            expect(output()).toContain('alpha');
            clean();
        } finally {
            fs.writeFileSync(join(root, 'control/other.release'), '');
            await exited;
        }
    });
});

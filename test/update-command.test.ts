import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn(), multiselect: vi.fn() }));
vi.mock('../src/cli/proc.js', () => ({ capture: mocks.capture, run: mocks.run }));
vi.mock('../src/cli/create.js', () => ({ MIGRATIONS_README: 'migrations' }));
vi.mock('@clack/prompts', () => ({
    cancel: vi.fn(),
    intro: vi.fn(),
    isCancel: () => false,
    multiselect: mocks.multiselect,
    note: vi.fn(),
    outro: vi.fn(),
    spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));
import { runUpdate } from '../src/cli/update';

const dirs: string[] = [];
function project(deps: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-update-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: deps }));
    return dir;
}
function read(dir: string) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>;
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.run.mockResolvedValue(undefined);
});
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('update compiler policy', () => {
    it('applies exactly the reviewed TypeScript 7 version without running ncu again', async () => {
        const root = project({ typescript: '^6.0.3', react: '^19.2.0' });
        mocks.capture.mockResolvedValue({
            code: 0,
            stdout: '{"typescript":"^7.0.2","react":"^19.3.0"}',
            stderr: '',
        });
        await runUpdate({ cwd: root, yes: true });
        expect(read(root).devDependencies).toEqual({ typescript: '^7.0.2', react: '^19.3.0' });
        expect(mocks.capture).toHaveBeenCalledTimes(1);
        expect(mocks.run).toHaveBeenCalledExactlyOnceWith('npm', ['install'], root, {
            stdio: 'inherit',
        });
    });

    it('offers a 7.x migration even when a patch target or future latest would select another major', async () => {
        const root = project({ typescript: '^6.0.3' });
        mocks.capture
            .mockResolvedValueOnce({ code: 0, stdout: '{"typescript":"^8.0.0"}', stderr: '' })
            .mockResolvedValueOnce({ code: 0, stdout: '["7.0.2","7.1.0"]', stderr: '' });
        await runUpdate({ cwd: root, yes: true, target: 'patch' });
        expect(read(root).devDependencies.typescript).toBe('^7.1.0');
        expect(mocks.capture).toHaveBeenLastCalledWith(
            'npm',
            ['view', 'typescript@7', 'version', '--json'],
            root,
        );
    });

    it('does not install other updates while an unsupported compiler is left unselected', async () => {
        const root = project({ typescript: '^6.0.3', react: '^19.2.0' });
        mocks.capture.mockResolvedValue({
            code: 0,
            stdout: '{"typescript":"^7.0.2","react":"^19.3.0"}',
            stderr: '',
        });
        mocks.multiselect.mockResolvedValue(['react']);
        await expect(runUpdate({ cwd: root })).rejects.toThrow('Select the TypeScript 7 migration');
        expect(read(root).devDependencies.react).toBe('^19.2.0');
        expect(mocks.run).not.toHaveBeenCalled();
    });
});

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('loads the published preset from node_modules without TypeScript stripping', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-preset-package-'));
    try {
        const modules = path.join(temp, 'node_modules');
        const installed = path.join(modules, 'toiljs');
        fs.mkdirSync(installed, { recursive: true });
        fs.cpSync(path.join(root, 'presets'), path.join(installed, 'presets'), { recursive: true });
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        fs.writeFileSync(
            path.join(installed, 'package.json'),
            JSON.stringify({ type: 'module', exports: { './oxlint': pkg.exports['./oxlint'] } }),
        );
        for (const name of ['oxlint', 'eslint-plugin-react-hooks', '@stylistic/eslint-plugin']) {
            fs.mkdirSync(path.dirname(path.join(modules, name)), { recursive: true });
            fs.symlinkSync(
                path.join(root, 'node_modules', name),
                path.join(modules, name),
                'junction',
            );
        }
        const result = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                "import config from 'toiljs/oxlint'; console.log(config.options.typeAware)",
            ],
            { cwd: temp, encoding: 'utf8' },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('true');
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

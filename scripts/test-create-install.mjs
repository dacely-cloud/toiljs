import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { satisfies } from 'semver';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-create-install-'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function npm(args, cwd) {
    // Honor the invoking npm version so the regression can also be checked with npm 11.
    const cli = process.env.npm_execpath;
    execFileSync(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args, {
        cwd,
        stdio: 'inherit',
    });
}

try {
    const cached = path.join(temp, 'cached');
    fs.mkdirSync(cached);
    fs.writeFileSync(path.join(cached, 'package.json'), '{"private":true}\n');

    // npx retains the old CLI and its automatically installed TypeScript 6 peer. Updating
    // that existing tree to a CLI with a TypeScript 7 peer fails before create can run.
    console.log('Installing the pre-TypeScript-7 CLI to reproduce an existing npx cache.');
    npm(['install', 'toiljs@0.0.116', '--ignore-scripts', '--no-audit', '--no-fund'], cached);
    const oldTypeScript = JSON.parse(
        fs.readFileSync(path.join(cached, 'node_modules/typescript/package.json'), 'utf8'),
    );
    assert.ok(satisfies(oldTypeScript.version, '>=6.0.0 <7.0.0'));

    npm(['pack', '--ignore-scripts', '--silent', '--pack-destination', temp], root);
    const artifact = path.join(temp, `toiljs-${pkg.version}.tgz`);
    console.log('Upgrading the cached CLI using the package that will be published.');
    npm(['install', artifact, '--ignore-scripts', '--no-audit', '--no-fund'], cached);

    execFileSync(
        process.execPath,
        [
            path.join(cached, 'node_modules/toiljs/build/cli/index.js'),
            'create',
            'app',
            '--yes',
            '--no-install',
            '--no-git',
            '--no-ai',
            '--style',
            'sass',
            '--tailwind',
        ],
        { cwd: cached, stdio: 'inherit' },
    );

    const app = path.join(cached, 'app');
    const appPackage = path.join(app, 'package.json');
    const generated = JSON.parse(fs.readFileSync(appPackage, 'utf8'));
    assert.equal(generated.dependencies.toiljs, `^${pkg.version}`);
    // The new version is not on npm yet; install the same artifact in the generated app.
    generated.dependencies.toiljs = artifact;
    fs.writeFileSync(appPackage, JSON.stringify(generated, null, 4) + '\n');
    npm(['install', '--no-audit', '--no-fund'], app);
    const compiler = JSON.parse(
        fs.readFileSync(path.join(app, 'node_modules/typescript/package.json'), 'utf8'),
    );
    assert.ok(satisfies(compiler.version, '>=7.0.2 <8.0.0'));
    npm(['run', 'build'], app);
    npm(['run', 'typecheck'], app);
    npm(['run', 'lint', '--', '--format', 'default', '--threads', '1'], app);
    console.log('Cached CLI upgrade, project installation, build, typecheck, and lint passed.');
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}

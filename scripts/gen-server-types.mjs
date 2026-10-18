// Ship declarations separately from ToilScript source so a clean tree can be
// typechecked without asking tsc to understand the WebAssembly dialect.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(root, 'server/runtime');
const outRoot = join(root, 'std/server');
function sources(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? sources(join(dir, entry.name))
            : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
              ? [join(dir, entry.name)]
              : [],
    );
}
const require = createRequire(import.meta.url);
const assemblyTypes = join(
    dirname(require.resolve('toilscript/package.json')),
    'std/types/assembly/index.d.ts',
);
const tmp = mkdtempSync(join(tmpdir(), 'toil-server-types-'));
try {
    const config = join(tmp, 'tsconfig.json');
    writeFileSync(
        config,
        JSON.stringify({
            files: [...sources(sourceRoot), assemblyTypes],
            compilerOptions: {
                declaration: true,
                emitDeclarationOnly: true,
                noCheck: true,
                skipLibCheck: true,
                module: 'ESNext',
                target: 'ESNext',
                moduleResolution: 'bundler',
                experimentalDecorators: true,
                noLib: true,
                types: [],
                rootDir: root,
                outDir: join(tmp, 'out'),
            },
        }),
    );
    const bin = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
    const emitted = spawnSync(process.execPath, [bin, '-p', config], {
        cwd: root,
        encoding: 'utf8',
    });
    if (emitted.status !== 0) throw new Error(emitted.stdout + emitted.stderr);
    const emittedRoot = join(tmp, 'out/server/runtime');
    rmSync(outRoot, { recursive: true, force: true });
    function copy(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const file = join(dir, entry.name);
            if (entry.isDirectory()) {
                copy(file);
                continue;
            }
            if (!entry.name.endsWith('.d.ts')) continue;
            const rel = relative(emittedRoot, file);
            const path = join(outRoot, rel);
            mkdirSync(dirname(path), { recursive: true });
            const prefix =
                rel === 'index.d.ts' ? '/// <reference path="../../server/globals.d.ts" />\n' : '';
            writeFileSync(
                path,
                '// Generated from server/runtime by scripts/gen-server-types.mjs.\n' +
                    prefix +
                    readFileSync(file, 'utf8'),
            );
        }
    }
    copy(emittedRoot);
    readFileSync(join(outRoot, 'index.d.ts'));
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

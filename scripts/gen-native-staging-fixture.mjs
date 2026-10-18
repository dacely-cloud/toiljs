import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(process.argv[2] ?? join(root, '../toil-backend'));
const directory = join(backend, 'tests/fixtures/native-staging');
const temporary = mkdtempSync(join(tmpdir(), 'toil-native-staging-'));
try {
    mkdirSync(join(temporary, 'node_modules'));
    symlinkSync(root, join(temporary, 'node_modules/toiljs'));
    writeFileSync(join(temporary, 'app.ts'), readFileSync(join(directory, 'request_src.ts')));
    const compiled = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ??
                join(root, 'node_modules/toilscript/bin/toilscript.js'),
            'app.ts',
            '-o',
            join(directory, 'request.wasm'),
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
        ],
        { cwd: temporary, encoding: 'utf8' },
    );
    if (compiled.status !== 0) throw new Error(compiled.stdout + compiled.stderr);
    const hash = createHash('sha256')
        .update(readFileSync(join(directory, 'request.wasm')))
        .digest('hex');
    writeFileSync(
        join(directory, 'HOW_BUILT.txt'),
        `Source: request_src.ts, using the public ToilScript SDK and toiljs server runtime.\nRegenerate from toiljs:\n  TOILSCRIPT_TEST_BIN=/path/to/toilscript/bin/toilscript.js node scripts/gen-native-staging-fixture.mjs /path/to/toil-backend\nSHA256 request.wasm: ${hash}\n`,
    );
    console.log('Generated native staging fixture:', hash);
} finally {
    rmSync(temporary, { recursive: true, force: true });
}

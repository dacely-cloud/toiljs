import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(process.argv[2] ?? join(root, '../toil-backend'));
const directory = join(backend, 'tests/fixtures/atomic-batch');
const temporary = mkdtempSync(join(tmpdir(), 'toil-native-atomic-'));
try {
    writeFileSync(join(temporary, 'app.ts'), readFileSync(join(directory, 'sdk_src.ts')));
    const compiled = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ??
                join(root, 'node_modules/toilscript/bin/toilscript.js'),
            'app.ts',
            '-o',
            join(directory, 'sdk.wasm'),
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
        ],
        { cwd: temporary, encoding: 'utf8' },
    );
    if (compiled.status !== 0) throw new Error(compiled.stdout + compiled.stderr);
    const hash = createHash('sha256')
        .update(readFileSync(join(directory, 'sdk.wasm')))
        .digest('hex');
    writeFileSync(
        join(directory, 'HOW_BUILT.txt'),
        `Source: sdk_src.ts, using the public ToilScript Db.atomic/AtomicBatch/AtomicDocuments API.\nRegenerate from toiljs:\n  TOILSCRIPT_TEST_BIN=/path/to/toilscript/bin/toilscript.js node scripts/gen-native-atomic-fixture.mjs /path/to/toil-backend\nSHA256 sdk.wasm: ${hash}\n`,
    );
    console.log('Generated native atomic batch fixture:', hash);
} finally {
    rmSync(temporary, { recursive: true, force: true });
}

// Regenerate the native-host fixture from the actual shipped ToilScript SDK.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(process.argv[2] ?? join(root, '../toil-backend'));
const fixture = join(backend, 'tests/fixtures/blobs');
const temporary = mkdtempSync(join(tmpdir(), 'toil-native-blobs-'));
try {
    mkdirSync(join(temporary, 'node_modules'));
    symlinkSync(root, join(temporary, 'node_modules/toiljs'));
    writeFileSync(join(temporary, 'app.ts'), readFileSync(join(fixture, 'presign_src.ts')));
    const result = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ??
                join(root, 'node_modules/toilscript/bin/toilscript.js'),
            'app.ts',
            '-o',
            join(fixture, 'presign.wasm'),
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
        ],
        { cwd: temporary, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    const hash = createHash('sha256')
        .update(readFileSync(join(fixture, 'presign.wasm')))
        .digest('hex');
    writeFileSync(
        join(fixture, 'HOW_BUILT.txt'),
        `Source: presign_src.ts, importing toiljs/server/runtime/files/blobs.\nRegenerate from the toiljs checkout:\n  TOILSCRIPT_TEST_BIN=/path/to/toilscript/bin/toilscript.js node scripts/gen-native-blob-fixture.mjs /path/to/toil-backend\nUses public AWS example credentials; no real storage account is contacted.\nSHA256 presign.wasm: ${hash}\n`,
    );
    console.log('Generated native blob fixture:', hash);
} finally {
    rmSync(temporary, { recursive: true, force: true });
}

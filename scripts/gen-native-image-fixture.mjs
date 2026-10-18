import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(process.argv[2] ?? join(root, '../toil-backend'));
const fixture = join(backend, 'tests/fixtures/images');
const temporary = mkdtempSync(join(tmpdir(), 'toil-native-images-'));
try {
    mkdirSync(join(temporary, 'node_modules'));
    symlinkSync(root, join(temporary, 'node_modules/toiljs'));
    writeFileSync(join(temporary, 'app.ts'), readFileSync(join(fixture, 'sdk_src.ts')));
    const result = spawnSync(
        process.execPath,
        [
            process.env.TOILSCRIPT_TEST_BIN ??
                join(root, 'node_modules/toilscript/bin/toilscript.js'),
            'app.ts',
            '-o',
            join(fixture, 'sdk.wasm'),
            '--runtime',
            'stub',
            '--memoryBase',
            '65536',
        ],
        { cwd: temporary, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    const raw = Buffer.alloc(8 * 4 * 4);
    for (let y = 0; y < 4; y++)
        for (let x = 0; x < 8; x++) raw.set([x * 30, y * 60, 100, 128], (y * 8 + x) * 4);
    const png = await sharp(raw, { raw: { width: 8, height: 4, channels: 4 } })
        .png()
        .withMetadata({
            orientation: 6,
            exif: { IFD0: { ImageDescription: 'synthetic-private-exif' } },
        })
        .toBuffer();
    writeFileSync(join(fixture, 'oriented.png'), png);
    const request = Buffer.alloc(24);
    request[0] = 1;
    request[2] = 90;
    request.writeUInt32LE(png.length, 20);
    const processed = spawnSync(
        process.execPath,
        ['--no-warnings', join(root, 'src/devserver/images/worker.mjs')],
        { input: Buffer.concat([request, png]) },
    );
    if (processed.status !== 0 || processed.stdout.readInt32LE() !== 0)
        throw new Error('image codec fixture generation failed');
    writeFileSync(join(fixture, 'stripped.png'), processed.stdout.subarray(18));
    const hash = createHash('sha256')
        .update(readFileSync(join(fixture, 'sdk.wasm')))
        .digest('hex');
    writeFileSync(
        join(fixture, 'HOW_BUILT.txt'),
        `Source: sdk_src.ts, importing toiljs/server/runtime/files/images.\nRegenerate from toiljs:\n  TOILSCRIPT_TEST_BIN=/path/to/toilscript/bin/toilscript.js node scripts/gen-native-image-fixture.mjs /path/to/toil-backend\nSHA256 sdk.wasm: ${hash}\n`,
    );
    console.log('Generated native image fixture:', hash);
} finally {
    rmSync(temporary, { recursive: true, force: true });
}

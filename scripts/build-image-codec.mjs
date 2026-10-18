import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? join(root, '../toil-backend/image-codec'));
const target = join(tmpdir(), 'toil-image-codec-target');
const env = {
    ...process.env,
    CARGO_TARGET_DIR: target,
    RUSTFLAGS: '-C link-arg=--max-memory=805306368 -C link-arg=-zstack-size=1048576',
};
const built = spawnSync(
    'cargo',
    [
        'build',
        '--locked',
        '--manifest-path',
        join(source, 'Cargo.toml'),
        '--target',
        'wasm32-wasip1',
        '--release',
    ],
    { env, cwd: source, encoding: 'utf8' },
);
if (built.status !== 0) throw new Error(built.stdout + built.stderr);
const asset = readFileSync(join(target, 'wasm32-wasip1/release/toil-image-codec.wasm'));
mkdirSync(join(root, 'assets'), { recursive: true });
writeFileSync(join(root, 'assets/image-codec.wasm'), asset);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputs = ['Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'src/main.rs'];
writeFileSync(
    join(root, 'assets/image-codec-build.json'),
    JSON.stringify(
        {
            sha256: hash(asset),
            maximumMemoryBytes: 805306368,
            sourceHashes: Object.fromEntries(
                inputs.map((file) => [file, hash(readFileSync(join(source, file)))]),
            ),
        },
        null,
        2,
    ) + '\n',
);
const metadata = spawnSync(
    'cargo',
    [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--manifest-path',
        join(source, 'Cargo.toml'),
    ],
    { cwd: source, encoding: 'utf8' },
);
if (metadata.status !== 0) throw new Error(metadata.stderr);
const packages = JSON.parse(metadata.stdout).packages;
let licenses =
    'The image-codec.wasm asset uses the following Rust packages.\nToil codec source: toil-backend/image-codec (Apache-2.0).\n';
for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
    if (pkg.name === 'toil-image-codec') continue;
    licenses += '\n===== ' + pkg.name + ' ' + pkg.version + ' (' + pkg.license + ') =====\n';
    const directory = dirname(pkg.manifest_path);
    for (const file of readdirSync(directory).filter((file) =>
        /^(licen[sc]e|copying|notice)/i.test(file),
    )) {
        try {
            licenses += '\n' + file + '\n' + readFileSync(join(directory, file), 'utf8') + '\n';
        } catch {
            /* license subdirectories have their own package metadata */
        }
    }
}
writeFileSync(join(root, 'assets/image-codec-LICENSES.txt'), licenses);
console.log('Built shared image codec', asset.length, 'bytes', hash(asset));

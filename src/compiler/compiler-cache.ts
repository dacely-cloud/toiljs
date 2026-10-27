import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface CompilerInput {
    readonly path: string;
    readonly hash: string | null;
}

export interface CompilerDirectory {
    readonly path: string;
    readonly entries: readonly string[] | null;
}

export interface CompilerOutput {
    readonly path: string;
    readonly hash: string;
    readonly staged?: string;
}

export interface CompilerManifest {
    readonly key: string;
    readonly inputs: readonly CompilerInput[];
    readonly directories: readonly CompilerDirectory[];
    readonly outputs: readonly CompilerOutput[];
    readonly stable: boolean;
}

export function digest(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

export function fileDigest(file: string): string | null {
    try {
        return digest(fs.readFileSync(file));
    } catch {
        return null;
    }
}

/** Match the compiler's library-directory lookup, including failed lookups. */
export function libraryEntries(dir: string): string[] | null {
    try {
        return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
    } catch {
        return null;
    }
}

export function inputsCurrent(manifest: CompilerManifest): boolean {
    return (
        manifest.stable &&
        manifest.inputs.every((input) => fileDigest(input.path) === input.hash) &&
        manifest.directories.every(
            (dir) => JSON.stringify(libraryEntries(dir.path)) === JSON.stringify(dir.entries),
        )
    );
}

export function outputsCurrent(manifest: CompilerManifest): boolean {
    return (
        manifest.outputs.length > 0 &&
        manifest.outputs.every((output) => fileDigest(output.path) === output.hash)
    );
}

/** A malformed, interrupted, or old manifest is a cache miss. */
export function readCompilerManifest(file: string): CompilerManifest | null {
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8')) as CompilerManifest;
        if (
            typeof value.key !== 'string' ||
            typeof value.stable !== 'boolean' ||
            !Array.isArray(value.inputs) ||
            !Array.isArray(value.directories) ||
            !Array.isArray(value.outputs)
        )
            return null;
        if (
            !value.inputs.every(
                (entry: CompilerInput) =>
                    entry &&
                    typeof entry.path === 'string' &&
                    (entry.hash === null || typeof entry.hash === 'string'),
            )
        )
            return null;
        if (
            !value.directories.every(
                (entry: CompilerDirectory) =>
                    entry &&
                    typeof entry.path === 'string' &&
                    (entry.entries === null ||
                        (Array.isArray(entry.entries) &&
                            entry.entries.every((name: unknown) => typeof name === 'string'))),
            )
        )
            return null;
        if (
            !value.outputs.every(
                (entry: CompilerOutput) =>
                    entry &&
                    typeof entry.path === 'string' &&
                    typeof entry.hash === 'string' &&
                    (entry.staged === undefined || typeof entry.staged === 'string'),
            )
        )
            return null;
        return value;
    } catch {
        return null;
    }
}

/** Custom transforms and extended configs can have untracked I/O: keep their builds uncached and serial. */
export function standardCompilerConfig(root: string): boolean {
    const inspect = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.every(inspect);
        if (value === null || typeof value !== 'object') return true;
        return Object.entries(value).every(([key, entry]) => {
            if (
                (key === 'transform' || key === 'extends') &&
                entry &&
                (!Array.isArray(entry) || entry.length > 0)
            )
                return false;
            return inspect(entry);
        });
    };
    try {
        return inspect(JSON.parse(fs.readFileSync(path.join(root, 'toilconfig.json'), 'utf8')));
    } catch {
        return false;
    }
}

/** Hash the installed compiler implementation, embedded standard library, and Binaryen runtime. */
export function compilerFingerprint(bin: string, worker: string): string {
    const hash = createHash('sha256');
    const compiler = path.resolve(path.dirname(bin), '..');
    const visit = (file: string): void => {
        const stat = fs.statSync(file);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(file).sort()) {
                if (entry !== 'node_modules' && !entry.endsWith('.map'))
                    visit(path.join(file, entry));
            }
        } else {
            hash.update(file).update('\0').update(fs.readFileSync(file)).update('\0');
        }
    };
    visit(worker);
    for (const name of ['compiler-cache', 'compiler-build'])
        visit(path.join(path.dirname(worker), name + path.extname(worker)));
    for (const dir of ['bin', 'dist', 'lib', 'util']) {
        const full = path.join(compiler, dir);
        if (fs.existsSync(full)) visit(full);
    }
    visit(path.join(compiler, 'package.json'));
    hash.update(process.version).update(
        JSON.stringify({
            NODE_OPTIONS: process.env.NODE_OPTIONS,
            BINARYEN_CORES: process.env.BINARYEN_CORES,
        }),
    );
    return hash.digest('hex');
}

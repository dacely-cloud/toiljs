import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CompilerManifest, CompilerOutput } from './compiler-cache.js';

// Keep the worker executable from a source checkout with Node's type stripping too.
function digest(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

function libraryEntries(dir: string): string[] | null {
    try {
        return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
            .sort();
    } catch {
        return null;
    }
}

interface CompilerApi {
    main(
        args: string[],
        options: {
            stdout: NodeJS.WriteStream;
            stderr: NodeJS.WriteStream;
            readFile(file: string, base: string): Promise<string | null>;
            listFiles(dir: string, base: string): string[] | null;
            writeFile(file: string, contents: string | Uint8Array, base: string): Promise<boolean>;
        },
    ): Promise<{ error: Error | null }>;
}

/** One isolated compiler instance. Record actual reads and stage all compiler-managed writes. */
async function compile(): Promise<void> {
    const [bin, staging, ...args] = process.argv.slice(2);
    if (!bin || !staging) throw new Error('Missing compiler worker arguments');
    const inputs = new Map<string, string | null>();
    const directories = new Map<string, string[] | null>();
    const outputs = new Map<string, CompilerOutput>();
    let stable = true;
    const api = (await import(
        pathToFileURL(path.resolve(path.dirname(bin), '../dist/cli.js')).href
    )) as CompilerApi;
    const result = await api.main(args, {
        stdout: process.stdout,
        stderr: process.stderr,
        async readFile(file, base) {
            const full = path.resolve(base, file);
            let content: string | null;
            try {
                content = await fs.promises.readFile(full, 'utf8');
            } catch {
                content = null;
            }
            const hash = content === null ? null : digest(content);
            if (inputs.has(full) && inputs.get(full) !== hash) stable = false;
            inputs.set(full, hash);
            return content;
        },
        listFiles(dir, base) {
            const full = path.resolve(base, dir);
            const entries = libraryEntries(full);
            if (
                directories.has(full) &&
                JSON.stringify(directories.get(full)) !== JSON.stringify(entries)
            )
                stable = false;
            directories.set(full, entries);
            return entries;
        },
        async writeFile(file, contents, base) {
            const full = path.resolve(base, file);
            const staged = path.join(staging, digest(full));
            await fs.promises.writeFile(staged, contents);
            outputs.set(full, { path: full, staged, hash: digest(contents) });
            return true;
        },
    });
    if (result.error) {
        process.exitCode = 1;
        return;
    }
    const manifest: CompilerManifest = {
        key: '',
        stable,
        inputs: [...inputs].map(([file, hash]) => ({ path: file, hash })),
        directories: [...directories].map(([dir, entries]) => ({ path: dir, entries })),
        outputs: [...outputs.values()],
    };
    await fs.promises.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
}

await compile().catch((error: unknown) => {
    process.stderr.write(`toiljs compiler worker: ${String(error)}\n`);
    process.exitCode = 1;
});

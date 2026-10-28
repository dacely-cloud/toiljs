import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    compilerFingerprint,
    compilerCacheMiss,
    digest,
    fileDigest,
    inputsCurrent,
    outputsCurrent,
    readCompilerManifest,
    standardCompilerConfig,
    type CompilerManifest,
} from './compiler-cache.js';

export interface CompilerPass {
    readonly name: string;
    readonly args: readonly string[];
}

export interface CompilerBuildOptions {
    readonly signal?: AbortSignal;
    /** Validate the complete generation using staged bytes before anything becomes visible. */
    readonly validate?: (readOutput: (file: string) => Buffer) => void;
}

interface CompletedPass {
    readonly pass: CompilerPass;
    readonly manifest: CompilerManifest;
    readonly cache: string;
    readonly key: string;
    readonly reused: boolean;
}

function runProcess(
    root: string,
    args: readonly string[],
    name: string,
    signal: AbortSignal,
    cores: number,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let failure: Error | undefined;
        const child = spawn(process.execPath, ['--enable-source-maps', ...args], {
            cwd: root,
            stdio: 'inherit',
            signal,
            env: { ...process.env, BINARYEN_CORES: process.env.BINARYEN_CORES ?? String(cores) },
        });
        child.on('error', (error) => {
            failure = error;
            if (child.pid === undefined) reject(error);
        });
        // Abort errors arrive before exit: always drain a launched child before returning.
        child.on('close', (code) =>
            code === 0 && !failure
                ? resolve()
                : reject(
                      failure ??
                          new Error(`toilscript ${name} build failed (exit ${String(code)})`),
                  ),
        );
    });
}

/** Commit a staged file without exposing partial bytes, including outDirs on a different filesystem. */
function publish(staged: string, destination: string): void {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
        fs.renameSync(staged, destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        const temporary = destination + `.toil-${process.pid}.tmp`;
        try {
            fs.copyFileSync(staged, temporary);
            fs.renameSync(temporary, destination);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }
}

/** Isolated tier compiles, a publication barrier, and dependency-verified incremental reuse. */
export async function runCompilerPasses(
    root: string,
    bin: string,
    passes: readonly CompilerPass[],
    finalize: () => void,
    options: CompilerBuildOptions = {},
): Promise<void> {
    const home = path.join(root, '.toil', 'compiler');
    fs.mkdirSync(home, { recursive: true });
    const work = fs.mkdtempSync(path.join(home, `pending-${process.pid}-`));
    const builtWorker = fileURLToPath(new URL('./toilscript-worker.js', import.meta.url));
    const worker = fs.existsSync(builtWorker) ? builtWorker : builtWorker.replace(/\.js$/, '.ts');
    const standard = standardCompilerConfig(root);
    const cacheable = standard && process.env.TOILJS_BUILD_CACHE !== '0';
    const requested = Number(process.env.TOILJS_BUILD_JOBS ?? 3);
    const jobs = Number.isInteger(requested) && requested > 0 ? requested : 3;
    const cpus = availableParallelism();
    const abort = new AbortController();
    const cancel = (): void => abort.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) abort.abort();
    const stop = (): void => {
        process.exitCode = 130;
        abort.abort();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const completed: CompletedPass[] = [];
    let firstFailure: { readonly reason: unknown } | undefined;
    let index = 0;
    try {
        if (!standard) {
            // Unknown transforms/config extensions may depend on previous passes' writes.
            // Preserve the original CLI and serial I/O semantics instead of guessing their dependencies.
            for (const pass of passes)
                await runProcess(root, [bin, ...pass.args], pass.name, abort.signal, cpus);
            options.validate?.((file) => fs.readFileSync(path.resolve(root, file)));
            finalize();
            return;
        }
        const fingerprint = cacheable ? compilerFingerprint(bin, worker) : '';
        const plans = passes.map((pass) => {
            const cache = path.join(home, `${pass.name}.json`);
            const key = digest(JSON.stringify({ version: 1, root, fingerprint, args: pass.args }));
            const saved = cacheable ? readCompilerManifest(cache) : null;
            const miss = compilerCacheMiss(saved, key);
            const cached = cacheable && miss === null ? saved : null;
            if (process.env.TOILJS_BUILD_CACHE_DEBUG === '1')
                process.stdout.write(
                    `  server cache ${pass.name}: ${cached ? 'hit' : !cacheable ? 'disabled' : miss}\n`,
                );
            return { pass, cache, key, cached };
        });
        const concurrency = Math.max(
            1,
            Math.min(plans.filter((plan) => !plan.cached).length, 3, cpus, jobs),
        );
        const cores = Math.max(1, Math.floor(cpus / concurrency));
        const run = async (): Promise<void> => {
            while (index < plans.length && !abort.signal.aborted) {
                const { pass, cache, key, cached } = plans[index++];
                if (cached) {
                    completed.push({ pass, manifest: cached, cache, key, reused: true });
                    continue;
                }
                const staging = path.join(work, pass.name);
                try {
                    fs.mkdirSync(staging);
                    await runProcess(
                        root,
                        [worker, bin, staging, ...pass.args],
                        pass.name,
                        abort.signal,
                        cores,
                    );
                    const manifest = readCompilerManifest(path.join(staging, 'manifest.json'));
                    if (!manifest || !inputsCurrent(manifest))
                        throw new Error(
                            `Server inputs changed while compiling ${pass.name}; retry the build.`,
                        );
                    completed.push({ pass, manifest, cache, key, reused: false });
                } catch (error) {
                    if (!abort.signal.aborted) firstFailure = { reason: error };
                    abort.abort();
                    throw error;
                }
            }
        };
        const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, run));
        if (firstFailure) throw firstFailure.reason;
        const failed = outcomes.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        if (abort.signal.aborted) throw new Error('Server build cancelled');
        // Recheck cached tiers too: source edits during another tier's compile must not bless a stale generation.
        if (completed.some(({ manifest }) => !inputsCurrent(manifest)))
            throw new Error('Server inputs changed during compilation; retry the build.');
        if (completed.some((result) => result.reused && !outputsCurrent(result.manifest)))
            throw new Error('Server outputs changed during compilation; retry the build.');
        const outputs = new Map<string, string>();
        for (const pass of passes) {
            const result = completed.find((entry) => entry.pass === pass);
            if (!result) throw new Error(`Compiler pass did not finish: ${pass.name}`);
            for (const output of result.manifest.outputs) {
                if (standard && outputs.has(output.path))
                    throw new Error(`Compiler tiers share an output path: ${output.path}`);
                outputs.set(output.path, output.staged ?? output.path);
            }
        }
        options.validate?.((file) =>
            fs.readFileSync(outputs.get(path.resolve(root, file)) ?? file),
        );
        // Preserve the dependency order: cold and stream artifacts precede the request artifact.
        for (const pass of passes) {
            const result = completed.find((entry) => entry.pass === pass);
            if (!result) throw new Error(`Compiler pass did not finish: ${pass.name}`);
            if (result.reused) continue;
            for (const output of result.manifest.outputs) {
                if (!output.staged) throw new Error(`Missing staged output: ${output.path}`);
                publish(output.staged, output.path);
            }
        }
        finalize();
        // Finalization can migrate the RPC client and append the stream surface. Hash the final bytes.
        if (cacheable)
            for (const result of completed) {
                if (result.reused) continue;
                const manifest: CompilerManifest = {
                    ...result.manifest,
                    key: result.key,
                    outputs: result.manifest.outputs.map((output) => {
                        const hash = fileDigest(output.path);
                        if (hash === null)
                            throw new Error(`Compiler output disappeared: ${output.path}`);
                        return { path: output.path, hash };
                    }),
                };
                const staged = path.join(work, `${result.pass.name}.json`);
                fs.writeFileSync(staged, JSON.stringify(manifest));
                publish(staged, result.cache);
            }
        const reused = completed.filter((pass) => pass.reused).map((pass) => pass.pass.name);
        if (reused.length > 0)
            process.stdout.write(`  ✓ server unchanged: reused ${reused.join(', ')}\n`);
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        options.signal?.removeEventListener('abort', cancel);
        fs.rmSync(work, { recursive: true, force: true });
    }
}

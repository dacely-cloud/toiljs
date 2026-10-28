/** Server-only client build publication. Never expose Vite's partially written output. */
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedToilConfig } from './config.js';

export class ClientPublication {
    /** Keep the current release readable through bundling, integrity, SSG and template generation. */
    public static async run(
        cfg: ResolvedToilConfig,
        compile: (staged: ResolvedToilConfig) => Promise<void>,
    ): Promise<void> {
        const destination: string = path.resolve(cfg.root, cfg.outDir);
        const home: string = path.join(cfg.root, '.toil', 'compiler');
        if (
            destination === path.parse(destination).root ||
            home === destination ||
            home.startsWith(destination + path.sep)
        )
            throw new Error(
                'client.outDir must be a dedicated directory outside the compiler staging directory.',
            );
        fs.mkdirSync(home, { recursive: true });
        const staging: string = fs.mkdtempSync(path.join(home, `pending-${process.pid}-`));
        const output: string = path.join(staging, 'client');
        let cancelled: boolean = false;
        const stop: () => void = (): void => {
            cancelled = true;
            process.exitCode = 130;
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
            await compile({
                ...cfg,
                outDir: output,
                vite: {
                    ...cfg.vite,
                    build: { ...cfg.vite.build, outDir: output, emptyOutDir: true },
                },
            });
            if (cancelled) throw new Error('Client build cancelled');
            if (!fs.existsSync(path.join(output, 'index.html')))
                throw new Error(
                    'Client build did not produce index.html. The previous output was preserved.',
                );
            const files: readonly string[] = ClientPublication.#files(output);
            // Every script, stylesheet and public asset must exist before any new document refers to it.
            const ordered: readonly string[] = [...files].sort(
                (left: string, right: string): number =>
                    Number(left.endsWith('.html')) - Number(right.endsWith('.html')) ||
                    Number(left === 'index.html') - Number(right === 'index.html') ||
                    left.localeCompare(right),
            );
            for (const file of ordered)
                ClientPublication.#publish(path.join(output, file), path.join(destination, file));
            // Keep only this generation. This is publication staging, not an archive of past releases.
            if (cfg.vite.build?.emptyOutDir !== false)
                ClientPublication.#prune(destination, new Set(files), '');
        } finally {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            fs.rmSync(staging, { recursive: true, force: true });
        }
    }
    static #files(directory: string, prefix: string = ''): readonly string[] {
        const files: string[] = [];
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative: string = path.join(prefix, entry.name);
            if (entry.isDirectory())
                files.push(...ClientPublication.#files(path.join(directory, entry.name), relative));
            else if (entry.isFile()) files.push(relative);
            else throw new Error(`Unsupported client output: ${relative}`);
        }
        return files;
    }
    static #publish(source: string, destination: string): void {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        try {
            fs.renameSync(source, destination);
        } catch (error: unknown) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV')
                throw error;
            const temporary: string = destination + `.toil-${process.pid}.tmp`;
            try {
                fs.copyFileSync(source, temporary);
                fs.renameSync(temporary, destination);
            } finally {
                fs.rmSync(temporary, { force: true });
            }
        }
    }
    static #prune(directory: string, current: ReadonlySet<string>, prefix: string): void {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative: string = path.join(prefix, entry.name);
            const location: string = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                ClientPublication.#prune(location, current, relative);
                if (fs.readdirSync(location).length === 0) fs.rmdirSync(location);
            } else if (!current.has(relative)) fs.unlinkSync(location);
        }
    }
}

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { build } from '../src/compiler/index.js';
import { loadConfig, type ResolvedToilConfig } from '../src/compiler/config.js';
import { ClientPublication } from '../src/compiler/client-publication.js';

let root: string;
function write(name: string, source: string): void {
    const file: string = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
}
beforeEach((): void => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.toil-client-publication-'));
    write('package.json', '{"type":"module"}');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(process.cwd(), path.join(root, 'node_modules/toiljs'), 'dir');
    write(
        'client/public/index.html',
        '<html><head></head><body><div id="root"></div></body></html>',
    );
    write(
        'client/routes/index.tsx',
        'export default function Page() { return <h1>Original page</h1>; }',
    );
    write(
        'client/global-error.tsx',
        'export default function ErrorPage() { return <h1>Try again</h1>; }',
    );
    write(
        'toil.config.mjs',
        `import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = ${JSON.stringify(root)};
export default { client: { images: false, fonts: false, vite: { logLevel: 'silent', plugins: [{
    name: 'publication-probe',
    writeBundle() {
        const snapshot = path.join(root, 'snapshot.json');
        if (!fs.existsSync(snapshot)) return;
        const files = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
        const readable = Object.entries(files).every(([name, bytes]) =>
            fs.existsSync(path.join(root, 'build/client', name)) &&
            createHash('sha256').update(fs.readFileSync(path.join(root, 'build/client', name))).digest('hex') === bytes);
        fs.writeFileSync(path.join(root, 'readable.json'), JSON.stringify(readable));
    },
    closeBundle() { if (fs.existsSync(path.join(root, 'fail'))) throw Error('Publication fixture failed'); }
}] } } };`,
    );
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});
afterEach((): void => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});
function snapshot(): Readonly<Record<string, string>> {
    const out: string = path.join(root, 'build/client');
    return Object.fromEntries(
        fs
            .readdirSync(out, { recursive: true, encoding: 'utf8' })
            .filter((name: string): boolean => fs.statSync(path.join(out, name)).isFile())
            .map((name: string): [string, string] => [
                name,
                createHash('sha256')
                    .update(fs.readFileSync(path.join(out, name)))
                    .digest('hex'),
            ]),
    );
}
function pending(): readonly string[] {
    return fs
        .readdirSync(path.join(root, '.toil/compiler'))
        .filter((name: string): boolean => name.startsWith('pending-'));
}
it('cancellation preserves the prior client output and cleans the staging directory', async (): Promise<void> => {
    write('build/client/index.html', 'old shell');
    const previousExitCode: typeof process.exitCode = process.exitCode;
    const cfg: ResolvedToilConfig = await loadConfig({ root });
    try {
        await expect(
            ClientPublication.run(cfg, async (staged: ResolvedToilConfig): Promise<void> => {
                fs.mkdirSync(staged.outDir, { recursive: true });
                fs.writeFileSync(path.join(staged.outDir, 'index.html'), 'cancelled shell');
                process.emit('SIGTERM');
            }),
        ).rejects.toThrow('Client build cancelled');
        expect(fs.readFileSync(path.join(root, 'build/client/index.html'), 'utf8')).toBe(
            'old shell',
        );
        expect(pending()).toEqual([]);
    } finally {
        process.exitCode = previousExitCode;
    }
});
it('publishes assets before documents and prunes old chunks only after publishing HTML', async (): Promise<void> => {
    write('build/client/index.html', 'old shell');
    write('build/client/assets/old.js', 'old chunk');
    const cfg: ResolvedToilConfig = await loadConfig({ root });
    const rename: typeof fs.renameSync = fs.renameSync.bind(fs);
    const documents: string[] = [];
    vi.spyOn(fs, 'renameSync').mockImplementation(
        (source: fs.PathLike, destination: fs.PathLike): void => {
            if (String(destination).endsWith('.html')) {
                expect(fs.existsSync(path.join(root, 'build/client/assets/new.js'))).toBe(true);
                expect(fs.existsSync(path.join(root, 'build/client/assets/old.js'))).toBe(true);
                documents.push(path.relative(path.join(root, 'build/client'), String(destination)));
            }
            rename(source, destination);
        },
    );
    await ClientPublication.run(cfg, async (staged: ResolvedToilConfig): Promise<void> => {
        fs.mkdirSync(path.join(staged.outDir, 'assets'), { recursive: true });
        fs.mkdirSync(path.join(staged.outDir, 'chat'), { recursive: true });
        fs.writeFileSync(path.join(staged.outDir, 'assets/new.js'), 'new chunk');
        fs.writeFileSync(path.join(staged.outDir, 'chat/index.html'), 'new chat');
        fs.writeFileSync(path.join(staged.outDir, 'index.html'), 'new shell');
    });
    expect(documents).toEqual(['chat/index.html', 'index.html']);
    expect(fs.existsSync(path.join(root, 'build/client/assets/old.js'))).toBe(false);
    expect(pending()).toEqual([]);
});
it('keeps the previous shell and lazy chunks readable during a real client build, then prunes obsolete output', async (): Promise<void> => {
    await build({ root });
    const before: Readonly<Record<string, string>> = snapshot();
    write('snapshot.json', JSON.stringify(before));
    write(
        'client/routes/index.tsx',
        'export default function Page() { return <h1>Replacement page</h1>; }',
    );
    await build({ root });
    expect(fs.readFileSync(path.join(root, 'readable.json'), 'utf8')).toBe('true');
    const after: Readonly<Record<string, string>> = snapshot();
    expect(after['index.html']).not.toBe(before['index.html']);
    expect(Object.keys(before).some((name: string): boolean => !(name in after))).toBe(true);
    const html: string = fs.readFileSync(path.join(root, 'build/client/index.html'), 'utf8');
    for (const match of html.matchAll(/"(\/assets\/[^" ]+\.js)":/g)) {
        const asset: string | undefined = match[1];
        if (asset === undefined) throw new Error('Missing integrity asset');
        expect(fs.existsSync(path.join(root, 'build/client', asset))).toBe(true);
    }
    expect(pending()).toEqual([]);
}, 30000);
it('a late plugin failure preserves the complete prior release and removes failed staging output', async (): Promise<void> => {
    await build({ root });
    const before: Readonly<Record<string, string>> = snapshot();
    write(
        'client/routes/index.tsx',
        'export default function Page() { return <h1>Must not publish</h1>; }',
    );
    write('fail', 'yes');
    await expect(build({ root })).rejects.toThrow('Publication fixture failed');
    expect(snapshot()).toEqual(before);
    expect(pending()).toEqual([]);
}, 30000);

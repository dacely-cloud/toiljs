import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import { loadConfig } from '../src/compiler/config.js';
import { generate } from '../src/compiler/generate.js';
import { mayExport } from '../src/compiler/prerender.js';
import { prerenderStaticParams } from '../src/compiler/ssg.js';
import { extractServerSlots, extractTemplates } from '../src/compiler/template-build.js';
import { renderEmails } from '../src/compiler/emails.js';
import { build } from '../src/compiler/index.js';

vi.mock('vite', async (original) => {
    const actual = await original<typeof import('vite')>();
    return { ...actual, createServer: vi.fn(actual.createServer) };
});

let root: string;
const shell = '<html><head></head><body><div id="root"></div></body></html>';

function write(file: string, source: string): string {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source);
    return destination;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.toil-route-selection-'));
    write('package.json', '{"type":"module"}');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(process.cwd(), path.join(root, 'node_modules/toiljs'), 'dir');
    write(
        'toil.config.mjs',
        `export default { client: {
        seo: { url: "https://example.com" },
        vite: { plugins: [{
            name: 'fixture-no-client-prebundle',
            configResolved(config) {
                config.optimizeDeps.noDiscovery = true;
                config.optimizeDeps.include = [];
            }
        }] }
    } };`,
    );
    write('client/public/index.html', shell);
    write('build/client/index.html', shell);
    write('.toil/index.html', shell);
    vi.mocked(createServer).mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('route export discovery', () => {
    it.each([
        ['export const ssr = true;', 'ssr', true],
        ['export const ssr = computeFlag();', 'ssr', true],
        ['export { flag as ssr } from "./flags";', 'ssr', true],
        ['export * from "./flags";', 'ssr', true],
        ['export * as flags from "./flags";', 'ssr', false],
        [
            'export async function generateStaticParams() { return []; }',
            'generateStaticParams',
            true,
        ],
        ['export { makeParams as generateStaticParams };', 'generateStaticParams', true],
        ['export const { ssr } = flags;', 'ssr', true],
        ['export = { ssr: true };', 'ssr', true],
        ['module.exports.ssr = true;', 'ssr', true],
        ['exports.ssr = true;', 'ssr', true],
        ['export default () => <h1>Your accounting exports</h1>;', 'ssr', false],
        ['// export const ssr = true;\nexport default function Page() {}', 'ssr', false],
        ['const ssr = true; export { ssr as other };', 'ssr', false],
        ['export const invalid = ;', 'ssr', true],
    ])('conservatively discovers %s', (source, name, expected) => {
        expect(mayExport(write('route.tsx', source), name)).toBe(expected);
    });

    it('does not retain stale export decisions across edits', () => {
        const file = write('route.tsx', 'export default function Page() {}');
        expect(mayExport(file, 'ssr')).toBe(false);
        write('route.tsx', 'export const ssr = true;');
        expect(mayExport(file, 'ssr')).toBe(true);
    });
});

describe('build work selection', () => {
    it('serializes complete builds of one project, including asynchronous client plugins', async () => {
        vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        write(
            'client/routes/index.tsx',
            'export default function Page() { return <h1>Serialized build</h1>; }',
        );
        write(
            'toil.config.mjs',
            `import {setTimeout} from 'node:timers/promises';
let active = false;
export default { client: { images: false, fonts: false, vite: { logLevel: 'silent', plugins: [{
    name: 'overlap-guard',
    async buildStart() { if(active) throw Error('overlapping client builds'); active = true; await setTimeout(50); },
    closeBundle() { active = false; }
}] } } };`,
        );
        await Promise.all([build({ root }), build({ root })]);
        expect(fs.existsSync(path.join(root, 'build/client/index.html'))).toBe(true);
        expect(fs.readdirSync(path.join(root, '.toil/compiler'))).not.toContain('lock');
    });
    it('never evaluates client-only route graphs or starts Vite for absent SSR/SSG opt-ins', async () => {
        write(
            'client/routes/index.tsx',
            'throw new Error("client-only graph"); export default function Page() {}',
        );
        write(
            'client/routes/[id].tsx',
            'throw new Error("client-only graph"); export default function Page() {}',
        );
        write('emails/auth-confirm.tsx', 'throw new Error("reserved auth override");');
        const cfg = await loadConfig({ root });
        expect(await extractServerSlots(cfg)).toEqual(new Map());
        expect((await extractTemplates(cfg)).generated).toEqual([]);
        expect(await prerenderStaticParams(cfg)).toEqual([]);
        await renderEmails(cfg, true);
        expect(createServer).not.toHaveBeenCalled();
    });

    it('still evaluates re-exported SSR and SSG opt-ins and preserves generated artifacts', async () => {
        write(
            'client/flags.ts',
            'export const enabled = true; export function params() { return [{ id: "first" }]; }',
        );
        write(
            'client/routes/hello.tsx',
            'export { enabled as ssr } from "../flags"; export default function Page() { return <h1>SSR still renders</h1>; }',
        );
        write(
            'client/routes/[id].tsx',
            'export { params as generateStaticParams } from "../flags"; export default function Page() { return <h1>SSG</h1>; }',
        );
        const cfg = await loadConfig({ root });
        generate(cfg);
        const slots = await extractServerSlots(cfg);
        expect(slots.has('hello')).toBe(true);
        const ssr = await extractTemplates(cfg);
        expect(ssr.generated).toContain('/hello');
        expect(fs.readFileSync(path.join(root, 'build/client/_ssr/hello.tmpl'), 'utf8')).toContain(
            'SSR still renders',
        );
        expect(await prerenderStaticParams(cfg)).toContain('/first');
        expect(fs.existsSync(path.join(root, 'build/client/first/index.html'))).toBe(true);
    });
});

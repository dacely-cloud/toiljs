import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyConfigure } from '../src/cli/configure';
import type { StyleFeatures } from '../src/cli/features';

const CSS: StyleFeatures = { preprocessor: 'css', tailwind: false };
const SASS_TW: StyleFeatures = { preprocessor: 'sass', tailwind: true };

const ENTRY = [
    "import { routes, layout, notFound } from 'toiljs/routes';",
    '',
    "import './styles/main.css';",
    '',
    'Toil.mount(routes, layout, notFound);',
    '',
].join('\n');

let dir: string;
let clientDir: string;
let pkgPath: string;

async function readJson(p: string): Promise<{ devDependencies?: Record<string, string> }> {
    return JSON.parse(await fs.readFile(p, 'utf8')) as { devDependencies?: Record<string, string> };
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toil-cfg-'));
    clientDir = path.join(dir, 'client');
    pkgPath = path.join(dir, 'package.json');
    await fs.mkdir(path.join(clientDir, 'styles'), { recursive: true });
    await fs.writeFile(path.join(clientDir, 'toil.tsx'), ENTRY, 'utf8');
    await fs.writeFile(path.join(clientDir, 'styles/main.css'), 'body { margin: 0; }\n', 'utf8');
    await fs.writeFile(pkgPath, JSON.stringify({ devDependencies: { typescript: '^6' } }, null, 4), 'utf8');
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('applyConfigure', () => {
    it('adds Sass + Tailwind: renames stylesheet, adds entry + imports + deps', async () => {
        const pkg = await readJson(pkgPath);
        await applyConfigure(clientDir, pkgPath, pkg, CSS, SASS_TW);

        expect(await exists(path.join(clientDir, 'styles/main.scss'))).toBe(true);
        expect(await exists(path.join(clientDir, 'styles/main.css'))).toBe(false);
        expect(await exists(path.join(clientDir, 'styles/tailwind.css'))).toBe(true);

        const entry = await fs.readFile(path.join(clientDir, 'toil.tsx'), 'utf8');
        expect(entry).toContain("import './styles/tailwind.css';");
        expect(entry).toContain("import './styles/main.scss';");
        expect(entry).not.toContain('main.css');
        expect(entry).toContain('Toil.mount(routes, layout, notFound);');

        const deps = (await readJson(pkgPath)).devDependencies ?? {};
        expect(deps).toHaveProperty('sass');
        expect(deps).toHaveProperty('tailwindcss');
        expect(deps).toHaveProperty('@tailwindcss/vite');
    });

    it('removes everything cleanly when switching back to plain CSS', async () => {
        const pkg = await readJson(pkgPath);
        await applyConfigure(clientDir, pkgPath, pkg, CSS, SASS_TW);
        const mid = await readJson(pkgPath);
        await applyConfigure(clientDir, pkgPath, mid, SASS_TW, CSS);

        expect(await exists(path.join(clientDir, 'styles/main.css'))).toBe(true);
        expect(await exists(path.join(clientDir, 'styles/main.scss'))).toBe(false);
        expect(await exists(path.join(clientDir, 'styles/tailwind.css'))).toBe(false);

        const deps = (await readJson(pkgPath)).devDependencies ?? {};
        expect(deps).not.toHaveProperty('sass');
        expect(deps).not.toHaveProperty('tailwindcss');
        expect(deps).not.toHaveProperty('@tailwindcss/vite');
        expect(deps).toHaveProperty('typescript');
    });
});

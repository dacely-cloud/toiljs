import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildPageIndex, pagesModuleSource } from '../src/compiler/pages';
import type { ScannedRoute } from '../src/compiler/routes';

const dirs: string[] = [];
/** Writes a throwaway routes dir with the given `{ relPath: source }` files, returns its path. */
function tmpRoutes(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toil-pages-'));
    dirs.push(dir);
    for (const [rel, src] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, src);
    }
    return dir;
}
function route(
    dir: string,
    file: string,
    pattern: string,
    extra: Partial<ScannedRoute> = {},
): ScannedRoute {
    return { file: path.join(dir, file), pattern, ...extra };
}

afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('buildPageIndex', () => {
    it('extracts each page metadata and flags dynamic routes', () => {
        const dir = tmpRoutes({
            'index.tsx': `export const metadata = { title: 'Home' };\nexport default () => null;\n`,
            'blog/[id].tsx': `export const metadata = { title: 'Post' };\nexport default () => null;\n`,
        });
        const pages = buildPageIndex(process.cwd(), [
            route(dir, 'index.tsx', '/'),
            route(dir, 'blog/[id].tsx', '/blog/:id'),
        ]);
        expect(pages).toEqual([
            { path: '/', dynamic: false, metadata: { title: 'Home' } },
            { path: '/blog/:id', dynamic: true, metadata: { title: 'Post' } },
        ]);
    });

    it('merges searchHints over static metadata (hints win) for dynamic discoverability', () => {
        const dir = tmpRoutes({
            'blog/[id].tsx':
                `export const searchHints = { title: 'Blog', keywords: ['posts', 'articles'] };\n` +
                `export const generateMetadata = ({ params }) => ({ title: params.id });\n` +
                `export default () => null;\n`,
        });
        const [page] = buildPageIndex(process.cwd(), [route(dir, 'blog/[id].tsx', '/blog/:id')]);
        expect(page).toEqual({
            path: '/blog/:id',
            dynamic: true,
            metadata: { title: 'Blog', keywords: ['posts', 'articles'] },
        });
    });

    it('uses an empty metadata object when a route declares none', () => {
        const dir = tmpRoutes({ 'about.tsx': `export default () => null;\n` });
        const pages = buildPageIndex(process.cwd(), [route(dir, 'about.tsx', '/about')]);
        expect(pages).toEqual([{ path: '/about', dynamic: false, metadata: {} }]);
    });

    it('excludes slots and intercepting routes, and dedupes patterns', () => {
        const dir = tmpRoutes({
            'index.tsx': `export const metadata = { title: 'Home' };\nexport default () => null;\n`,
            '@modal/photo.tsx': `export default () => null;\n`,
            '(.)photo.tsx': `export default () => null;\n`,
        });
        const pages = buildPageIndex(process.cwd(), [
            route(dir, 'index.tsx', '/'),
            route(dir, '@modal/photo.tsx', '/photo', { slot: 'modal' }),
            route(dir, '(.)photo.tsx', '/photo', { intercept: true }),
        ]);
        expect(pages.map((p) => p.path)).toEqual(['/']);
    });

    it('sorts the index by path for deterministic output', () => {
        const dir = tmpRoutes({
            'zed.tsx': `export default () => null;\n`,
            'about.tsx': `export default () => null;\n`,
        });
        const pages = buildPageIndex(process.cwd(), [
            route(dir, 'zed.tsx', '/zed'),
            route(dir, 'about.tsx', '/about'),
        ]);
        expect(pages.map((p) => p.path)).toEqual(['/about', '/zed']);
    });
});

describe('pagesModuleSource', () => {
    it('emits a typed pages export with JSON-serialized entries', () => {
        const src = pagesModuleSource([{ path: '/', dynamic: false, metadata: { title: 'Home' } }]);
        expect(src).toContain('export const pages: PageMeta[] = [');
        expect(src).toContain('{"path":"/","dynamic":false,"metadata":{"title":"Home"}}');
    });
});

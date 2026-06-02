import { describe, expect, it } from 'vitest';

import {
    defaultConfigSource,
    detectPreprocessor,
    detectTailwind,
    packageDiff,
    preprocessorForExt,
    requiredPackages,
    setConfigImages,
    setStyleImports,
    styleEntry,
    type StyleFeatures,
    styleImportLines,
} from '../src/cli/features';

const CSS: StyleFeatures = { preprocessor: 'css', tailwind: false };
const SASS_TW: StyleFeatures = { preprocessor: 'sass', tailwind: true };

describe('styleEntry / preprocessorForExt', () => {
    it('maps preprocessors to stylesheet paths', () => {
        expect(styleEntry('css')).toBe('styles/main.css');
        expect(styleEntry('sass')).toBe('styles/main.scss');
        expect(styleEntry('less')).toBe('styles/main.less');
        expect(styleEntry('stylus')).toBe('styles/main.styl');
    });

    it('reverses extensions back to preprocessors', () => {
        expect(preprocessorForExt('scss')).toBe('sass');
        expect(preprocessorForExt('.sass')).toBe('sass');
        expect(preprocessorForExt('less')).toBe('less');
        expect(preprocessorForExt('styl')).toBe('stylus');
        expect(preprocessorForExt('css')).toBe('css');
        expect(preprocessorForExt('txt')).toBeNull();
    });
});

describe('requiredPackages / packageDiff', () => {
    it('lists packages for a feature set', () => {
        expect(requiredPackages(CSS)).toEqual([]);
        expect(requiredPackages({ preprocessor: 'sass', tailwind: false })).toEqual(['sass']);
        expect(requiredPackages({ preprocessor: 'css', tailwind: true })).toEqual([
            'tailwindcss',
            '@tailwindcss/vite',
        ]);
    });

    it('diffs add/remove between two setups', () => {
        expect(packageDiff(CSS, SASS_TW)).toEqual({
            add: ['sass', 'tailwindcss', '@tailwindcss/vite'],
            remove: [],
        });
        expect(packageDiff(SASS_TW, CSS)).toEqual({
            add: [],
            remove: ['sass', 'tailwindcss', '@tailwindcss/vite'],
        });
        expect(
            packageDiff(
                { preprocessor: 'sass', tailwind: false },
                { preprocessor: 'less', tailwind: false },
            ),
        ).toEqual({ add: ['less'], remove: ['sass'] });
    });
});

describe('styleImportLines / setStyleImports', () => {
    it('orders Tailwind before the main stylesheet', () => {
        expect(styleImportLines(CSS)).toEqual(["import './styles/main.css';"]);
        expect(styleImportLines(SASS_TW)).toEqual([
            "import './styles/tailwind.css';",
            "import './styles/main.scss';",
        ]);
    });

    it('rewrites the app entry imports, preserving the rest', () => {
        const src = [
            "import { routes, layout, notFound } from 'toiljs/routes';",
            '',
            "import './styles/main.css';",
            '',
            'Toil.mount(routes, layout, notFound);',
            '',
        ].join('\n');

        const out = setStyleImports(src, SASS_TW);
        expect(out).toContain("import './styles/tailwind.css';");
        expect(out).toContain("import './styles/main.scss';");
        expect(out).not.toContain("import './styles/main.css';");
        expect(out).toContain("from 'toiljs/routes'");
        expect(out).toContain('Toil.mount(routes, layout, notFound);');
    });

    it('round-trips back to plain CSS (drops Tailwind import)', () => {
        const src = [
            "import { routes, layout, notFound } from 'toiljs/routes';",
            "import './styles/tailwind.css';",
            "import './styles/main.scss';",
            'Toil.mount(routes, layout, notFound);',
        ].join('\n');

        const out = setStyleImports(src, CSS);
        expect(out).toContain("import './styles/main.css';");
        expect(out).not.toContain('tailwind.css');
        expect(out).not.toContain('main.scss');
    });
});

describe('detect from dependencies', () => {
    it('finds the active preprocessor and Tailwind', () => {
        expect(detectPreprocessor({ sass: '^1' })).toBe('sass');
        expect(detectPreprocessor({ less: '^4' })).toBe('less');
        expect(detectPreprocessor({})).toBe('css');
        expect(detectTailwind({ '@tailwindcss/vite': '^4' })).toBe(true);
        expect(detectTailwind({ react: '^19' })).toBe(false);
    });
});

describe('setConfigImages / defaultConfigSource', () => {
    it('flips an existing images flag', () => {
        const src =
            'export default defineConfig({\n    client: {\n        images: true,\n    },\n});\n';
        expect(setConfigImages(src, false)).toContain('images: false');
        expect(setConfigImages(src, false)).not.toContain('images: true');
    });

    it('adds images to an existing client block', () => {
        const out = setConfigImages(
            'export default defineConfig({ client: { base: "/" } });',
            false,
        );
        expect(out).toContain('images: false');
        expect(out).toContain('base: "/"');
    });

    it('adds a client block to a bare config', () => {
        const out = setConfigImages('export default defineConfig({});', false);
        expect(out).toContain('client: { images: false }');
    });

    it('returns null when the shape is unrecognized', () => {
        expect(setConfigImages('const x = 1;', false)).toBeNull();
    });

    it('round-trips through defaultConfigSource', () => {
        const src = defaultConfigSource(false);
        expect(src).toContain('images: false');
        expect(setConfigImages(src, true)).toContain('images: true');
    });
});

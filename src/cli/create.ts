/**
 * `toiljs create` — an interactive project scaffolder (Clack-powered) that wires a new
 * app to the enforced toiljs presets (tsconfig / eslint / prettier) and file-based routing.
 * Supports a non-interactive path via flags (`--yes`, `--template`, …) for scripting/CI.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    intro,
    outro,
    text,
    select,
    multiselect,
    confirm,
    isCancel,
    cancel,
    spinner,
    note,
} from '@clack/prompts';
import { AI_HELPERS, AI_HELPER_IDS, aiHelperFiles, TOIL_DOCS, TOIL_ENV_DTS } from 'toiljs/compiler';
import pc from 'picocolors';

import {
    PKG_VERSION,
    PREPROCESSORS,
    requiredPackages,
    setStyleImports,
    styleEntry,
    styleImportLines,
    TAILWIND_CSS,
    TAILWIND_ENTRY,
    type Preprocessor,
    type StyleFeatures,
} from './features.js';
import { run } from './proc.js';
import { accent, dim, version } from './ui.js';
import { isPackageManager, isValidName, resolveProjectDir } from './validate.js';

export type Template = 'app' | 'minimal';

/** Human label for each preprocessor in the styling picker. */
const PREPROCESSOR_LABEL: Record<Preprocessor, string> = {
    css: 'Plain CSS',
    sass: 'Sass (SCSS)',
    less: 'Less',
    stylus: 'Stylus',
};

/** Default global stylesheet contents (palette base styles), shared by every preprocessor. */
const DEFAULT_STYLE_CONTENT =
    ':root {\n    color-scheme: dark;\n}\n\n' +
    'body {\n    margin: 0;\n    background: #080d11;\n    color: #f5f6fa;\n' +
    '    font-family: system-ui, -apple-system, sans-serif;\n    line-height: 1.6;\n}\n\n' +
    'a {\n    color: #2563ff;\n    text-decoration: none;\n}\n\n' +
    'a:hover {\n    color: #22e3ab;\n}\n\n' +
    'code {\n    background: #11161f;\n    color: #22e3ab;\n    padding: 0.1rem 0.4rem;\n' +
    '    border-radius: 4px;\n    font-size: 0.9em;\n}\n\n' +
    'h1 {\n    background: linear-gradient(90deg, #2563ff, #7c3aed, #22e3ab);\n' +
    '    -webkit-background-clip: text;\n    background-clip: text;\n    color: transparent;\n}\n';

/** A selectable template in the `create` wizard. */
interface TemplateOption {
    readonly value: Template;
    readonly label: string;
    readonly hint: string;
}

export interface CreateOptions {
    readonly name?: string;
    readonly template?: Template;
    readonly preprocessor?: Preprocessor;
    readonly tailwind?: boolean;
    /** AI assistant files to scaffold: `true` = all, `false` = none, omitted = ask. */
    readonly ai?: boolean;
    readonly install?: boolean;
    readonly git?: boolean;
    readonly pm?: string;
    readonly yes?: boolean;
    readonly cwd: string;
}

/** Aborts the wizard cleanly on Ctrl-C / cancel, narrowing the prompt result to its value type. */
function bail<T>(value: T | symbol): asserts value is T {
    if (isCancel(value)) {
        cancel('Scaffolding cancelled.');
        process.exit(0);
    }
}

async function isEmptyDir(dir: string): Promise<boolean> {
    try {
        const entries = await fs.readdir(dir);
        return entries.length === 0;
    } catch {
        return true;
    }
}

/** Builds the full file map (relative path → contents) for a scaffolded project. */
function scaffold(
    name: string,
    template: Template,
    features: StyleFeatures,
    aiTools: readonly string[],
): Record<string, string> {
    const toilVersion = version();
    const devDependencies: Record<string, string> = {
        '@types/react': '^19.2.15',
        '@types/react-dom': '^19.2.3',
        eslint: '^10.2.0',
        prettier: '^3.8.1',
        toilscript: '^0.1.2',
        typescript: '^6.0.3',
    };
    for (const dep of requiredPackages(features).sort()) {
        devDependencies[dep] = PKG_VERSION[dep] ?? 'latest';
    }
    const pkg = {
        name: path.basename(name),
        private: true,
        type: 'module',
        scripts: {
            dev: 'toiljs dev',
            build: 'toiljs build && toilscript --target release',
            'build:client': 'toiljs build',
            'build:server': 'toilscript --target release',
            lint: 'eslint client',
            typecheck: 'tsc --noEmit',
            format: 'prettier --write "client/**/*.{ts,tsx,css,scss,less}" "client/public/**/*.html"',
        },
        dependencies: {
            toiljs: `^${toilVersion}`,
            react: '^19.2.6',
            'react-dom': '^19.2.6',
        },
        devDependencies,
    };

    const files: Record<string, string> = {
        'package.json': JSON.stringify(pkg, null, 4) + '\n',
        'toil.config.ts':
            "import { defineConfig } from 'toiljs/compiler';\n\n" +
            'export default defineConfig({});\n',
        'tsconfig.json':
            '{\n    "extends": "toiljs/tsconfig",\n    "include": ["client", "toil-env.d.ts"]\n}\n',
        'eslint.config.js': "import toiljs from 'toiljs/eslint';\n\nexport default toiljs;\n",
        '.prettierrc': '"toiljs/prettier"\n',
        '.gitignore': 'node_modules\nbuild\n.toil\ntoil-env.d.ts\n',
        'toil-env.d.ts': TOIL_ENV_DTS,
        'toilconfig.json':
            JSON.stringify(
                {
                    entries: ['server/main.ts'],
                    targets: {
                        release: {
                            outFile: 'build/server/release.wasm',
                            textFile: 'build/server/release.wat',
                        },
                    },
                    options: {
                        sourceMap: false,
                        optimizeLevel: 3,
                        shrinkLevel: 1,
                        converge: true,
                        noAssert: false,
                        enable: [
                            'sign-extension',
                            'mutable-globals',
                            'nontrapping-f2i',
                            'bulk-memory',
                            'simd',
                            'reference-types',
                            'multi-value',
                        ],
                        runtime: 'stub',
                        memoryBase: 0,
                        initialMemory: 1,
                        debug: false,
                        trapMode: 'allow',
                    },
                },
                null,
                4,
            ) + '\n',
        'server/tsconfig.json':
            JSON.stringify(
                {
                    extends: 'toilscript/std/assembly.json',
                    include: ['./**/*.ts'],
                },
                null,
                4,
            ) + '\n',
        'server/index.ts': 'export function add(a: i32, b: i32): i32 {\n    return a + b;\n}\n',
        'server/main.ts':
            "import { add } from './index';\n\n" +
            '@main\nfunction run(): i32 {\n    return add(40, 2);\n}\n',
        'README.md': ['# ' + path.basename(name), '', 'A [toiljs](https://toil.org) app.', '', '## Develop', '', '    npm install', '    npm run dev', '', '## Build', '', '    npm run build', ''].join('\n'),
    };

    // The `app` template's client UI is copied from templates/app at runtime; `minimal` ships an
    // inline client here.
    if (template === 'minimal') Object.assign(files, minimalClient(name, features));

    // Selected AI-assistant pointer files at the root (committed). The real docs are always seeded
    // under .toil/docs (gitignored; regenerated by dev/build) since the framework manages them.
    Object.assign(files, aiHelperFiles(aiTools));
    for (const [docName, content] of Object.entries(TOIL_DOCS)) {
        files[`.toil/docs/${docName}`] = content;
    }

    return files;
}

/** The inline client UI for the `minimal` template (the `app` template copies templates/app). */
function minimalClient(name: string, features: StyleFeatures): Record<string, string> {
    const files: Record<string, string> = {
        'client/public/index.html':
            '<!doctype html>\n<html lang="en">\n  <head>\n' +
            '    <meta charset="utf-8" />\n' +
            '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
            '    <meta name="theme-color" content="#080D11" />\n' +
            '    <meta name="description" content="" />\n' +
            '    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n' +
            '    <link rel="manifest" href="/manifest.webmanifest" />\n' +
            `    <title>${path.basename(name)}</title>\n` +
            '  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n',
        'client/public/favicon.svg':
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n' +
            '  <defs>\n' +
            '    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">\n' +
            '      <stop offset="0" stop-color="#2563FF" />\n' +
            '      <stop offset="0.5" stop-color="#7C3AED" />\n' +
            '      <stop offset="1" stop-color="#22E3AB" />\n' +
            '    </linearGradient>\n' +
            '  </defs>\n' +
            '  <rect width="32" height="32" rx="7" fill="#080D11" />\n' +
            '  <path d="M9 10h14v3.2h-5.4V24h-3.2V13.2H9z" fill="url(#g)" />\n' +
            '</svg>\n',
        'client/public/robots.txt': 'User-agent: *\nAllow: /\n',
        'client/public/manifest.webmanifest':
            JSON.stringify(
                {
                    name: path.basename(name),
                    short_name: path.basename(name),
                    start_url: '/',
                    display: 'standalone',
                    background_color: '#080D11',
                    theme_color: '#080D11',
                    icons: [{ src: '/favicon.svg', type: 'image/svg+xml', sizes: 'any' }],
                },
                null,
                4,
            ) + '\n',
        'client/public/images/.gitkeep': '# Place images and other static assets here; served at /images/*.\n',
        'client/toil.tsx':
            "import { routes, layout, notFound } from 'toiljs/routes';\n\n" +
            styleImportLines(features).join('\n') +
            '\n\n' +
            'Toil.mount(routes, layout, notFound);\n',
        [`client/${styleEntry(features.preprocessor)}`]: DEFAULT_STYLE_CONTENT,
        'client/components/.gitkeep': '# Place shared React components here.\n',
        'client/layout.tsx': `import { type ReactNode } from 'react';

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '3rem 1.5rem' }}>
            <header
                style={{
                    display: 'flex',
                    gap: '1rem',
                    alignItems: 'baseline',
                    borderBottom: '1px solid #1b2330',
                    paddingBottom: '0.75rem',
                    marginBottom: '1.5rem',
                }}>
                <strong style={{ color: '#2563FF', fontSize: '1.1rem' }}>${path.basename(name)}</strong>
                <nav style={{ display: 'flex', gap: '1rem' }}>
                    <Toil.Link href="/">home</Toil.Link>
                </nav>
            </header>
            {children}
        </div>
    );
}
`,
        'client/routes/index.tsx':
            'export default function Home() {\n' +
            '    return (\n        <main>\n' +
            '            <h1>Welcome to toiljs</h1>\n' +
            '            <p>File-based routing, bundled by Vite, zero config.</p>\n' +
            '        </main>\n    );\n}\n',
    };
    if (features.tailwind) files[`client/${TAILWIND_ENTRY}`] = TAILWIND_CSS;
    return files;
}

/** Absolute path to a shipped template directory (e.g. `templates/app`). */
function templateDir(template: Template): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', template);
}

/**
 * Applies the chosen styling to a copied template's client dir: renames the stylesheet to the
 * preprocessor's extension, adds the Tailwind entry, and rewrites `toil.tsx`'s style imports.
 */
async function applyStyling(clientDir: string, features: StyleFeatures): Promise<void> {
    // Plain CSS without Tailwind is exactly what the template ships — leave it byte-for-byte.
    if (features.preprocessor === 'css' && !features.tailwind) return;
    const entry = styleEntry(features.preprocessor);
    if (entry !== 'styles/main.css') {
        await fs.rename(path.join(clientDir, 'styles', 'main.css'), path.join(clientDir, entry));
    }
    if (features.tailwind) {
        await fs.writeFile(path.join(clientDir, TAILWIND_ENTRY), TAILWIND_CSS, 'utf8');
    }
    const toilPath = path.join(clientDir, 'toil.tsx');
    await fs.writeFile(toilPath, setStyleImports(await fs.readFile(toilPath, 'utf8'), features), 'utf8');
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
    for (const [rel, contents] of Object.entries(files)) {
        const full = path.join(dir, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, contents, 'utf8');
    }
}

/** Runs the create flow (interactive unless `--yes`). */
export async function runCreate(opts: CreateOptions): Promise<void> {
    intro(accent(' toiljs create '));

    let name = opts.name;
    if (!name) {
        if (opts.yes) {
            name = 'my-toil-app';
        } else {
            const answer = await text({
                message: 'Project name',
                placeholder: 'my-toil-app',
                defaultValue: 'my-toil-app',
                validate: (v) => {
                    const result = isValidName(v || 'my-toil-app');
                    return result === true ? undefined : result;
                },
            });
            bail(answer);
            name = answer.trim() || 'my-toil-app';
        }
    }
    const valid = isValidName(name);
    if (valid !== true) {
        cancel(valid);
        process.exit(1);
    }

    const targetDir = resolveProjectDir(opts.cwd, name);
    if (targetDir === null) {
        cancel('Project name must stay inside the current directory (no "..", no absolute paths).');
        process.exit(1);
    }
    const rel = path.relative(opts.cwd, targetDir) || '.';

    if (!(await isEmptyDir(targetDir))) {
        if (opts.yes) {
            cancel(`Directory ${pc.cyan(rel)} is not empty.`);
            process.exit(1);
        }
        const proceed = await confirm({
            message: `Directory ${pc.cyan(rel)} is not empty. Scaffold into it anyway?`,
            initialValue: false,
        });
        bail(proceed);
        if (!proceed) {
            cancel('Scaffolding cancelled.');
            process.exit(0);
        }
    }

    let template: Template = opts.template ?? 'app';
    if (!opts.template && !opts.yes) {
        const templateOptions: TemplateOption[] = [
            { value: 'app', label: 'App', hint: 'the full ToilJS starter — landing page, layout, styles, demo routes' },
            { value: 'minimal', label: 'Minimal', hint: 'just a layout and a home route' },
        ];
        const choice = await select({ message: 'Which template?', options: templateOptions, initialValue: 'app' });
        bail(choice);
        template = choice === 'minimal' ? 'minimal' : 'app';
    }

    let preprocessor: Preprocessor = opts.preprocessor ?? 'css';
    let tailwind = opts.tailwind ?? false;
    if (!opts.yes) {
        if (opts.preprocessor === undefined) {
            const choice = await select<Preprocessor>({
                message: 'Styling',
                options: PREPROCESSORS.map((value) => ({ value, label: PREPROCESSOR_LABEL[value] })),
                initialValue: 'css',
            });
            bail(choice);
            preprocessor = choice;
        }
        if (opts.tailwind === undefined) {
            const tw = await confirm({ message: 'Add Tailwind CSS?', initialValue: false });
            bail(tw);
            tailwind = tw;
        }
    }
    const features: StyleFeatures = { preprocessor, tailwind };

    // AI assistant files: --ai = all, --no-ai = none, otherwise ask (default: all selected).
    let aiTools: string[] = opts.ai === false ? [] : [...AI_HELPER_IDS];
    if (opts.ai === undefined && !opts.yes) {
        const picked = await multiselect<string>({
            message: 'AI assistant files (read by Claude, Cursor, Codex, Copilot)',
            options: AI_HELPERS.map((h) => ({ value: h.id, label: h.label })),
            initialValues: [...AI_HELPER_IDS],
            required: false,
        });
        bail(picked);
        aiTools = picked;
    }

    let initGit = opts.git ?? false;
    let install = opts.install ?? false;
    const pm = opts.pm ?? 'npm';
    if (!isPackageManager(pm)) {
        cancel(`Unsupported package manager: ${pm} (use npm, pnpm, yarn, or bun).`);
        process.exit(1);
    }
    if (!opts.yes) {
        if (opts.git === undefined) {
            const g = await confirm({ message: 'Initialize a git repository?', initialValue: true });
            bail(g);
            initGit = g;
        }
        if (opts.install === undefined) {
            const i = await confirm({ message: 'Install dependencies now?', initialValue: false });
            bail(i);
            install = i;
        }
    }

    const s = spinner();
    s.start('Scaffolding project');
    await writeFiles(targetDir, scaffold(name, template, features, aiTools));
    if (template === 'app') {
        // Copy the full ToilJS starter UI, set its <title> to the project name, then apply styling.
        await fs.cp(templateDir('app'), targetDir, { recursive: true });
        const indexHtml = path.join(targetDir, 'client', 'public', 'index.html');
        const html = await fs.readFile(indexHtml, 'utf8');
        await fs.writeFile(
            indexHtml,
            html.replace(/<title>[^<]*<\/title>/, `<title>${path.basename(name)}</title>`),
        );
        await applyStyling(path.join(targetDir, 'client'), features);
    }
    s.stop(`Scaffolded ${pc.cyan(rel)}`);

    if (initGit) {
        const g = spinner();
        g.start('Initializing git repository');
        try {
            await run('git', ['init', '-q'], targetDir);
            await run('git', ['add', '-A'], targetDir);
            g.stop('Initialized git repository');
        } catch {
            g.stop(pc.yellow('Skipped git init (git not available)'));
        }
    }

    if (install) {
        const i = spinner();
        i.start(`Installing dependencies with ${pm}`);
        try {
            await run(pm, ['install'], targetDir);
            i.stop('Installed dependencies');
        } catch {
            i.stop(pc.yellow(`Could not install with ${pm} — run it yourself later`));
            install = false;
        }
    }

    const steps: string[] = [];
    if (rel !== '.') steps.push(`cd ${rel}`);
    if (!install) steps.push('npm install');
    steps.push(`${accent('npm run dev')}   ${dim('start the dev server')}`);
    steps.push(`${accent('npm run build')} ${dim('build for production')}`);
    note(steps.map((l) => dim('  ') + l).join('\n'), 'Next steps');

    outro(`Created ${accent(path.basename(name))} — happy building! ${dim('· v' + version())}`);
}

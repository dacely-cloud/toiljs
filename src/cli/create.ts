/**
 * `toiljs create` — an interactive project scaffolder (Clack-powered) that wires a new
 * app to the enforced toiljs presets (tsconfig / eslint / prettier) and file-based routing.
 * Supports a non-interactive path via flags (`--yes`, `--template`, …) for scripting/CI.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { intro, outro, text, select, confirm, isCancel, cancel, spinner, note } from '@clack/prompts';
import pc from 'picocolors';

import { accent, dim, version } from './ui.js';

export type Template = 'app' | 'minimal';

/** A selectable template in the `create` wizard. */
interface TemplateOption {
    readonly value: Template;
    readonly label: string;
    readonly hint: string;
}

export interface CreateOptions {
    readonly name?: string;
    readonly template?: Template;
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

function isValidName(name: string): true | string {
    if (!name.trim()) return 'Please enter a project name.';
    if (!/^[a-z0-9._@/-]+$/i.test(name)) return 'Use letters, numbers, dashes, dots or slashes.';
    return true;
}

async function isEmptyDir(dir: string): Promise<boolean> {
    try {
        const entries = await fs.readdir(dir);
        return entries.length === 0;
    } catch {
        return true; // doesn't exist yet
    }
}

/** Builds the full file map (relative path → contents) for a scaffolded project. */
function scaffold(name: string, template: Template): Record<string, string> {
    const toilVersion = version();
    const pkg = {
        name: path.basename(name),
        private: true,
        type: 'module',
        scripts: {
            dev: 'toiljs dev',
            build: 'toiljs build',
            lint: 'eslint client',
            typecheck: 'tsc --noEmit',
            format: 'prettier --write "client/**/*.{ts,tsx}"',
        },
        dependencies: {
            toiljs: `^${toilVersion}`,
            react: '^19.2.6',
            'react-dom': '^19.2.6',
        },
        devDependencies: {
            '@types/react': '^19.2.15',
            '@types/react-dom': '^19.2.3',
            eslint: '^10.2.0',
            prettier: '^3.8.1',
            typescript: '^6.0.3',
        },
    };

    const files: Record<string, string> = {
        'package.json': JSON.stringify(pkg, null, 4) + '\n',
        'toil.config.ts':
            "import { defineConfig } from 'toiljs/compiler';\n\n" +
            'export default defineConfig({\n    client: {\n        outDir: \'dist\',\n    },\n});\n',
        'tsconfig.json':
            '{\n    "extends": "toiljs/tsconfig",\n    "include": ["client", "toil-env.d.ts"]\n}\n',
        'eslint.config.js': "import toiljs from 'toiljs/eslint';\n\nexport default toiljs;\n",
        '.prettierrc': '"toiljs/prettier"\n',
        '.gitignore': 'node_modules\ndist\n.toil\ntoil-env.d.ts\n',
        'README.md': ['# ' + path.basename(name), '', 'A [toiljs](https://toil.org) app.', '', '## Develop', '', '    npm install', '    npm run dev', '', '## Build', '', '    npm run build', ''].join('\n'),
        'client/layout.tsx': `import { type ReactNode } from 'react';

import { Link } from 'toiljs/client';

const styles = \`
  :root { color-scheme: dark; }
  body { margin: 0; background: #080D11; color: #F5F6FA; font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; }
  a { color: #2563FF; text-decoration: none; }
  a:hover { color: #22E3AB; }
  code { background: #11161f; color: #22E3AB; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
  h1 { background: linear-gradient(90deg, #2563FF, #7C3AED, #22E3AB); -webkit-background-clip: text; background-clip: text; color: transparent; }
\`;

export default function Layout({ children }: { children?: ReactNode }) {
    return (
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '3rem 1.5rem' }}>
            <style>{styles}</style>
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
                    <Link href="/">home</Link>${template === 'app' ? '\n                    <Link href="/about">about</Link>' : ''}
                </nav>
            </header>
            {children}
        </div>
    );
}
`,
        'client/routes/index.tsx':
            "import { Link } from 'toiljs/client';\n\n" +
            'export default function Home() {\n' +
            '    return (\n        <main>\n' +
            '            <h1>Welcome to toiljs</h1>\n' +
            '            <p>File-based routing, bundled by Vite, zero config.</p>\n' +
            (template === 'app'
                ? '            <p>\n                <Link href="/about">About</Link> · <Link href="/blog/42">Blog post 42</Link>\n            </p>\n'
                : '') +
            '        </main>\n    );\n}\n',
    };

    if (template === 'app') {
        files['client/routes/about.tsx'] =
            "import { Link } from 'toiljs/client';\n\n" +
            'export default function About() {\n' +
            '    return (\n        <main>\n            <h1>About</h1>\n' +
            '            <p>\n                This page is served by <code>client/routes/about.tsx</code>.\n            </p>\n' +
            '            <Link href="/">Back home</Link>\n        </main>\n    );\n}\n';
        files['client/routes/blog/[id].tsx'] =
            "import { Link, useParams } from 'toiljs/client';\n\n" +
            'export default function BlogPost() {\n' +
            '    const { id } = useParams();\n' +
            '    return (\n        <main>\n            <h1>Blog post {id}</h1>\n' +
            '            <p>\n                Dynamic route from <code>client/routes/blog/[id].tsx</code>.\n            </p>\n' +
            '            <Link href="/">Back home</Link>\n        </main>\n    );\n}\n';
    }

    return files;
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
    for (const [rel, contents] of Object.entries(files)) {
        const full = path.join(dir, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, contents, 'utf8');
    }
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, stdio: 'ignore', shell: process.platform === 'win32' });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${String(code)}`))));
    });
}

/** Runs the create flow (interactive unless `--yes`). */
export async function runCreate(opts: CreateOptions): Promise<void> {
    intro(accent(' toiljs create '));

    // 1. Project name
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

    const targetDir = path.resolve(opts.cwd, name);
    const rel = path.relative(opts.cwd, targetDir) || '.';

    // 2. Guard against clobbering a non-empty dir
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

    // 3. Template
    let template: Template = opts.template ?? 'app';
    if (!opts.template && !opts.yes) {
        const templateOptions: TemplateOption[] = [
            { value: 'app', label: 'App', hint: 'layout + home/about + a dynamic /blog/[id] route' },
            { value: 'minimal', label: 'Minimal', hint: 'just a layout and a home route' },
        ];
        const choice = await select({ message: 'Which template?', options: templateOptions, initialValue: 'app' });
        bail(choice);
        template = choice === 'minimal' ? 'minimal' : 'app';
    }

    // 4. Options: git + install
    let initGit = opts.git ?? false;
    let install = opts.install ?? false;
    const pm = opts.pm ?? 'npm';
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

    // 5. Scaffold
    const s = spinner();
    s.start('Scaffolding project');
    await writeFiles(targetDir, scaffold(name, template));
    s.stop(`Scaffolded ${pc.cyan(rel)}`);

    // 6. git init (best-effort)
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

    // 7. Install (best-effort)
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

    // 8. Next steps
    const steps: string[] = [];
    if (rel !== '.') steps.push(`cd ${rel}`);
    if (!install) steps.push('npm install');
    steps.push(`${accent('npm run dev')}   ${dim('start the dev server')}`);
    steps.push(`${accent('npm run build')} ${dim('build for production')}`);
    note(steps.map((l) => dim('  ') + l).join('\n'), 'Next steps');

    outro(`Created ${accent(path.basename(name))} — happy building! ${dim('· v' + version())}`);
}

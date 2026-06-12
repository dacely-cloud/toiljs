#!/usr/bin/env node
/**
 * toiljs CLI. Routes `create` / `dev` / `build` and wraps them in the toiljs brand banner.
 * The compiler stays presentation-free (imported via the package's own `toiljs/compiler`
 * export); the epic bits, banner, the Clack scaffolding wizard, live here.
 */
import { build, dev, start } from 'toiljs/compiler';

import { runConfigure } from './configure.js';
import { runCreate, type Template } from './create.js';
import { runDoctor } from './doctor.js';
import { notifyIfOutdated } from './notify.js';
import { runUpdate } from './update.js';
import { type Preprocessor, PREPROCESSORS } from './features.js';
import { accent, banner, bold, danger, dim, success, version } from './ui.js';

interface Flags {
    root?: string;
    port?: number;
    host?: string;
    name?: string;
    template?: Template;
    preprocessor?: Preprocessor;
    tailwind?: boolean;
    ai?: boolean;
    images?: boolean;
    install?: boolean;
    git?: boolean;
    pm?: string;
    yes?: boolean;
    json?: boolean;
    fix?: boolean;
    target?: string;
    server?: boolean;
}

function parseArgs(argv: string[]): Flags {
    const flags: Flags = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--root':
                flags.root = argv[++i];
                break;
            case '--port': {
                const port = Number(argv[++i]);
                if (!Number.isNaN(port)) flags.port = port;
                break;
            }
            case '--host':
                flags.host = argv[++i];
                break;
            case '--template':
            case '-t': {
                const t = argv[++i];
                if (t === 'app' || t === 'minimal') flags.template = t;
                break;
            }
            case '--pm':
                flags.pm = argv[++i];
                break;
            case '--style': {
                const s = argv[++i];
                if ((PREPROCESSORS as readonly string[]).includes(s))
                    flags.preprocessor = s as Preprocessor;
                break;
            }
            case '--tailwind':
                flags.tailwind = true;
                break;
            case '--no-tailwind':
                flags.tailwind = false;
                break;
            case '--ai':
                flags.ai = true;
                break;
            case '--no-ai':
                flags.ai = false;
                break;
            case '--images':
                flags.images = true;
                break;
            case '--no-images':
                flags.images = false;
                break;
            case '--install':
                flags.install = true;
                break;
            case '--no-install':
                flags.install = false;
                break;
            case '--git':
                flags.git = true;
                break;
            case '--no-git':
                flags.git = false;
                break;
            case '-y':
            case '--yes':
                flags.yes = true;
                break;
            case '--json':
                flags.json = true;
                break;
            case '--fix':
                flags.fix = true;
                break;
            case '--target':
                flags.target = argv[++i];
                break;
            case '--server':
                flags.server = true;
                break;
            default:
                if (!arg.startsWith('-') && flags.name === undefined) flags.name = arg;
        }
    }
    return flags;
}

function printHelp(): void {
    const cmd = (name: string, desc: string): string => `  ${accent(name.padEnd(15))}${dim(desc)}`;
    process.stdout.write(
        [
            `${bold('Usage')}  ${dim('toiljs')} <command> [options]`,
            '',
            bold('Commands'),
            cmd('create [name]', 'scaffold a new toiljs app'),
            cmd('configure', 'toggle styling features (Sass/Less/Stylus, Tailwind)'),
            cmd('dev', 'start the dev server with HMR'),
            cmd('build', 'build the optimized production bundle'),
            cmd('start', 'self-host the built app (hyper-express / uWS)'),
            cmd('doctor', 'diagnose project setup and dependencies'),
            cmd('update', 'check for and apply dependency updates'),
            '',
            bold('Options'),
            cmd('--root <dir>', 'project root (default: current directory)'),
            cmd('--port <n>', 'dev server port'),
            cmd('-t, --template', 'create: app | minimal'),
            cmd('--style <name>', 'create/configure: css | sass | less | stylus'),
            cmd('--tailwind', 'create/configure: enable Tailwind (--no-tailwind to remove)'),
            cmd('--no-ai', 'create: skip AI assistant files (CLAUDE.md, etc.)'),
            cmd('-y, --yes', 'create: accept defaults (non-interactive)'),
            cmd('--no-install', "create: don't install dependencies"),
            cmd('--server', 'build: build only the server (regenerate shared/server.ts + wasm)'),
            cmd('--json', 'doctor: machine-readable output'),
            cmd('--fix', 'doctor: auto-fix what it can (typed-RPC wiring)'),
            cmd('--target <t>', 'update: latest | minor | patch | newest | greatest'),
            cmd('-v, --version', 'print the toiljs version'),
            '',
            dim('  Every command checks npm for a newer toiljs and warns when outdated.'),
            dim('  Set TOILJS_NO_UPDATE_CHECK=1 to opt out.'),
            '',
        ].join('\n') + '\n',
    );
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);

    if (command === '--version' || command === '-v') {
        process.stdout.write(version() + '\n');
        return;
    }

    const flags = parseArgs(rest);

    // Every invocation (including `npm run dev` / `npm run build`, which call this CLI)
    // checks that the installed toiljs is the latest release. Warns on stderr, never blocks
    // the command; opt out with TOILJS_NO_UPDATE_CHECK=1.
    await notifyIfOutdated(flags.root);

    switch (command) {
        case 'create':
            banner();
            await runCreate({
                name: flags.name,
                template: flags.template,
                preprocessor: flags.preprocessor,
                tailwind: flags.tailwind,
                ai: flags.ai,
                images: flags.images,
                install: flags.install,
                git: flags.git,
                pm: flags.pm,
                yes: flags.yes,
                cwd: process.cwd(),
            });
            break;

        case 'configure':
            banner();
            await runConfigure({
                root: flags.root,
                preprocessor: flags.preprocessor,
                tailwind: flags.tailwind,
                images: flags.images,
                install: flags.install,
                cwd: process.cwd(),
            });
            break;

        case 'dev':
            banner();
            process.stdout.write(dim('  starting dev server…') + '\n\n');
            await dev({ root: flags.root, port: flags.port });
            break;

        case 'build':
            banner();
            process.stdout.write(
                dim(flags.server ? '  building the server…' : '  building for production…') +
                    '\n\n',
            );
            await build({ root: flags.root, serverOnly: flags.server });
            process.stdout.write(
                '\n' +
                    success('  ✓ ') +
                    bold(flags.server ? 'server build complete' : 'build complete') +
                    '\n\n',
            );
            break;

        case 'start': {
            banner();
            process.stdout.write(dim('  self-hosting the built app…') + '\n\n');
            const server = await start({ root: flags.root, port: flags.port, host: flags.host });
            process.stdout.write(
                accent('  ➜ ') +
                    bold(`http://localhost:${String(server.port)}`) +
                    dim(`   ws channel: ${server.wsPath}`) +
                    '\n\n',
            );
            break;
        }

        case 'doctor':
            // Skip the banner for --json so stdout stays valid JSON.
            if (!flags.json) banner();
            await runDoctor({
                root: flags.root,
                cwd: process.cwd(),
                json: flags.json,
                fix: flags.fix,
            });
            break;

        case 'update':
            banner();
            await runUpdate({
                root: flags.root,
                cwd: process.cwd(),
                yes: flags.yes,
                target: flags.target,
            });
            break;

        case 'help':
        case '--help':
        case '-h':
        case undefined:
            banner();
            printHelp();
            break;

        default:
            banner();
            process.stdout.write(dim(`  unknown command: ${command}`) + '\n\n');
            printHelp();
            process.exitCode = 1;
    }
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write('\n' + danger('  ✗ ') + message + '\n');
    process.exitCode = 1;
});

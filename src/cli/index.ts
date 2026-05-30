#!/usr/bin/env node
/**
 * toiljs CLI. Routes `create` / `dev` / `build` and wraps them in the toiljs brand banner.
 * The compiler stays presentation-free (imported via the package's own `toiljs/compiler`
 * export); the epic bits — banner, the Clack scaffolding wizard — live here.
 */
import { build, dev, start } from 'toiljs/compiler';

import { runCreate, type Template } from './create.js';
import { accent, banner, bold, dim, version } from './ui.js';

interface Flags {
    root?: string;
    port?: number;
    name?: string;
    template?: Template;
    install?: boolean;
    git?: boolean;
    pm?: string;
    yes?: boolean;
}

function parseArgs(argv: string[]): Flags {
    const flags: Flags = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--root':
                flags.root = argv[++i];
                break;
            case '--port':
                flags.port = Number(argv[++i]);
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
            default:
                // First bare (non-flag) token is the positional project name.
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
            cmd('dev', 'start the dev server with HMR'),
            cmd('build', 'build the optimized production bundle'),
            cmd('start', 'self-host the built app (hyper-express / uWS)'),
            '',
            bold('Options'),
            cmd('--root <dir>', 'project root (default: current directory)'),
            cmd('--port <n>', 'dev server port'),
            cmd('-t, --template', 'create: app | minimal'),
            cmd('-y, --yes', 'create: accept defaults (non-interactive)'),
            cmd('--no-install', "create: don't install dependencies"),
            cmd('-v, --version', 'print the toiljs version'),
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

    switch (command) {
        case 'create':
            banner();
            await runCreate({
                name: flags.name,
                template: flags.template,
                install: flags.install,
                git: flags.git,
                pm: flags.pm,
                yes: flags.yes,
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
            process.stdout.write(dim('  building for production…') + '\n\n');
            await build({ root: flags.root });
            process.stdout.write('\n' + accent('  ✓ ') + bold('build complete') + '\n\n');
            break;

        case 'start': {
            banner();
            process.stdout.write(dim('  self-hosting the built app…') + '\n\n');
            const server = await start({ root: flags.root, port: flags.port });
            process.stdout.write(
                accent('  ➜ ') +
                    bold(`http://localhost:${String(server.port)}`) +
                    dim(`   ws channel: ${server.wsPath}`) +
                    '\n\n',
            );
            break;
        }

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
    process.stderr.write('\n' + accent('  ✗ ') + message + '\n');
    process.exitCode = 1;
});

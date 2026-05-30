#!/usr/bin/env node
/**
 * toil CLI. Delegates to the compiler (imported via the package's own `toiljs/compiler`
 * export, which self-resolves at runtime). Commands: `toil dev`, `toil build`.
 */
import { build, dev } from 'toiljs/compiler';

interface CliFlags {
    root?: string;
    port?: number;
}

function parseFlags(argv: string[]): CliFlags {
    const flags: CliFlags = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root') flags.root = argv[++i];
        else if (argv[i] === '--port') flags.port = Number(argv[++i]);
    }
    return flags;
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    const flags = parseFlags(rest);

    switch (command) {
        case 'dev':
            await dev(flags);
            break;
        case 'build':
            await build(flags);
            console.log('toil: build complete');
            break;
        default:
            console.log('Usage: toil <dev|build> [--root <dir>] [--port <n>]');
    }
}

void main();

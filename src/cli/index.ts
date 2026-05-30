#!/usr/bin/env node
/**
 * toil CLI. Thin entry that delegates to the compiler (loaded by sibling path so the per-target
 * tsc builds stay isolated). Commands: `toil dev`, `toil build`.
 */

interface CompilerModule {
    dev: (opts: { root?: string; port?: number }) => Promise<unknown>;
    build: (opts: { root?: string }) => Promise<void>;
}

function parseFlags(argv: string[]): { root?: string; port?: number } {
    const flags: { root?: string; port?: number } = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root') flags.root = argv[++i];
        else if (argv[i] === '--port') flags.port = Number(argv[++i]);
    }
    return flags;
}

async function loadCompiler(): Promise<CompilerModule> {
    const url = new URL('../compiler/index.js', import.meta.url).href;
    return (await import(url)) as CompilerModule;
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    const flags = parseFlags(rest);

    switch (command) {
        case 'dev': {
            const compiler = await loadCompiler();
            await compiler.dev(flags);
            break;
        }
        case 'build': {
            const compiler = await loadCompiler();
            await compiler.build(flags);
            console.log('toil: build complete');
            break;
        }
        default:
            console.log('Usage: toil <dev|build> [--root <dir>] [--port <n>]');
    }
}

void main();

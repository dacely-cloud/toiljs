#!/usr/bin/env node
/**
 * toiljs CLI entry. Placeholder commands that will delegate to the compiler engine.
 */

function main(): void {
    const command = process.argv[2];

    switch (command) {
        case 'build':
            console.log('toil: build (placeholder)');
            break;
        case 'dev':
            console.log('toil: dev (placeholder)');
            break;
        default:
            console.log('Usage: toil <build|dev>');
    }
}

main();

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

/** A controllable compiler API fixture: real child processes, real I/O, no optimizer timing assumptions. */
export async function main(args, io) {
    const option = (name) => args[args.indexOf(name) + 1];
    const name = option('--name');
    const control = path.resolve('control');
    fs.appendFileSync(path.join(control, 'calls'), name + '\n');
    fs.writeFileSync(path.join(control, name + '.started'), String(process.pid));
    const source = await io.readFile('input.ts', '.');
    const optional = await io.readFile('optional.ts', '.');
    const files = io.listFiles('library', '.') ?? [];
    const libraries = await Promise.all(files.map((file) => io.readFile('library/' + file, '.')));
    const output = JSON.stringify({ source, optional, libraries });
    await io.writeFile(option('--outFile'), output, '.');
    fs.writeFileSync(path.join(control, name + '.ready'), '');
    if (args.includes('--hold')) {
        while (!fs.existsSync(path.join(control, name + '.release'))) await setTimeout(10);
    }
    fs.writeFileSync(path.join(control, name + '.finished'), '');
    return { error: args.includes('--fail') ? new Error('intentional failure') : null };
}

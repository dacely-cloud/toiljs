/**
 * `toiljs db <action>` — manage the dev server's on-disk ToilDB data.
 *
 * Under `toiljs dev`, the in-process ToilDB emulator persists every family
 * (records / views / unique / events / membership / counter / capacity) plus each
 * row's schema_version to `<root>/.toil/devdata.json` (so data + migrations survive
 * restarts). These subcommands let you inspect, reset, snapshot, and restore that
 * store from outside a running server — handy for fixtures, sharing repro data, or
 * wiping a corrupt dev state. The snapshot is the exact JSON the dev DB writes, so
 * an exported file imports cleanly (and a hand-crafted one seeds the dev DB).
 */
import fs from 'node:fs';
import path from 'node:path';

import { accent, bold, danger, dim, success, warn } from './ui.js';

export interface DbOptions {
    /** Project root (where `.toil/` lives); defaults to the current directory. */
    root?: string;
}

/** The top-level families a valid snapshot carries (mirrors DbSnapshot). */
const FAMILIES = ['store', 'views', 'members', 'counters', 'events', 'eventDedup', 'capacity'] as const;

function devdataPath(opts: DbOptions): string {
    return path.join(path.resolve(opts.root ?? process.cwd()), '.toil', 'devdata.json');
}

function out(line: string): void {
    process.stdout.write(line + '\n');
}

/** Per-family key counts for a snapshot file, or null if unreadable. */
function familyCounts(file: string): Record<string, number> | null {
    let snap: Record<string, unknown>;
    try {
        snap = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
    const counts: Record<string, number> = {};
    for (const f of FAMILIES) {
        const fam = snap[f];
        counts[f] = fam && typeof fam === 'object' ? Object.keys(fam).length : 0;
    }
    return counts;
}

function isSnapshot(v: unknown): boolean {
    return typeof v === 'object' && v !== null && FAMILIES.every((f) => f in (v as object));
}

/** Run `toiljs db <action> [fileArg]`. */
export function runDb(action: string | undefined, fileArg: string | undefined, opts: DbOptions): void {
    const file = devdataPath(opts);
    const rel = path.relative(process.cwd(), file) || file;

    switch (action) {
        case 'reset':
        case 'purge': {
            if (!fs.existsSync(file)) {
                out(dim(`  dev database already empty (${rel} not found)`));
                return;
            }
            fs.rmSync(file);
            out(success('  ✓ ') + 'dev database reset ' + dim(`(${rel} deleted)`));
            return;
        }

        case 'export': {
            if (!fs.existsSync(file)) {
                out(warn('  ! ') + `nothing to export (${rel} not found)`);
                process.exitCode = 1;
                return;
            }
            let pretty: string;
            try {
                pretty = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')), null, 2) + '\n';
            } catch {
                out(danger('  ✗ ') + `the dev database at ${rel} is unreadable`);
                process.exitCode = 1;
                return;
            }
            if (fileArg === undefined) {
                process.stdout.write(pretty); // no banner/prefix -> pipe-friendly
                return;
            }
            fs.writeFileSync(path.resolve(fileArg), pretty);
            out(success('  ✓ ') + 'exported dev database to ' + dim(fileArg));
            return;
        }

        case 'import': {
            if (fileArg === undefined) {
                out(danger('  ✗ ') + 'usage: ' + dim('toiljs db import <file>'));
                process.exitCode = 1;
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
            } catch (e) {
                out(danger('  ✗ ') + `cannot read/parse ${fileArg}: ${(e as Error).message}`);
                process.exitCode = 1;
                return;
            }
            if (!isSnapshot(parsed)) {
                out(danger('  ✗ ') + `${fileArg} is not a toiljs dev database snapshot`);
                process.exitCode = 1;
                return;
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(parsed)); // compact: the dev DB's on-disk form
            out(success('  ✓ ') + `imported dev database from ${dim(fileArg)} ` + dim(`(${rel})`));
            return;
        }

        case 'path':
            out(file); // bare path, scriptable
            return;

        case 'status':
        case 'info': {
            out(bold('  dev database') + dim(`  ${rel}`));
            if (!fs.existsSync(file)) {
                out(dim('  (empty — no data written yet; run the dev server to populate it)'));
                return;
            }
            const counts = familyCounts(file);
            if (counts === null) {
                out(danger('  ✗ unreadable snapshot'));
                process.exitCode = 1;
                return;
            }
            out(dim(`  ${(fs.statSync(file).size / 1024).toFixed(1)} KiB`));
            const nonEmpty = FAMILIES.filter((f) => counts[f] > 0);
            if (nonEmpty.length === 0) out(dim('  (no rows)'));
            else for (const f of nonEmpty) out('  ' + accent(f.padEnd(12)) + String(counts[f]));
            return;
        }

        default:
            out(
                [
                    bold('Usage') + '  ' + dim('toiljs db') + ' <action>',
                    '',
                    bold('Actions'),
                    '  ' + accent('status'.padEnd(16)) + dim('show the dev DB path + per-family row counts'),
                    '  ' + accent('reset'.padEnd(16)) + dim('delete all dev data (alias: purge)'),
                    '  ' + accent('export [file]'.padEnd(16)) + dim('write a snapshot to <file> (or stdout)'),
                    '  ' + accent('import <file>'.padEnd(16)) + dim('replace the dev DB with a snapshot'),
                    '  ' + accent('path'.padEnd(16)) + dim('print the devdata.json path'),
                ].join('\n'),
            );
            if (action !== undefined) process.exitCode = 1; // unknown action
            return;
    }
}

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHostImports, freshDispatchState } from '../src/devserver/runtime/host.js';
import { devDb, __resetDbForTests, DbFunctionKind } from '../src/devserver/db/index.js';

describe('typed event erasure', () => {
    it('erases ordinary and appendOnce entries through real compiled bindings and survives restart', async () => {
        const root = mkdtempSync(join(tmpdir(), 'toil-event-erasure-'));
        try {
            const source = join(root, 'events.ts');
            const artifact = join(root, 'events.wasm');
            const snapshot = join(root, 'db.json');
            writeFileSync(
                source,
                `
@data class Key { id: i32 = 1; }
@data class Change { text: string = ''; }
@database class Changes { @collection static events: Events<Key,Change>; }
@action export function seed(): void {
  const a = new Change(); a.text = 'personal words';
  Changes.events.appendOnce(new Key(), 'private', a);
  const b = new Change(); b.text = 'keep this'; Changes.events.append(new Key(), b);
}
@action export function erasePrivate(): bool {
  const reference = Changes.events.reference(new Key(), 'private');
  return reference != null && Changes.events.redact(new Key(), reference);
}
@query export function getPrivate(): bool { return Changes.events.get(new Key(), 'private') != null; }
@query export function getLast(): i32 {
  const last = Changes.events.last(new Key()); return last == null ? 0 : last.text.length;
}
@job export function count(): i32 {
  const page = Changes.events.entries(new Key(), 1);
  return page.entries.length + (page.hasMore ? Changes.events.entries(new Key(), 1, page.cursor).entries.length : 0);
}
@job export function eraseOrdinary(): bool {
  const page = Changes.events.entries(new Key(), 8);
  return page.entries.length == 1 && Changes.events.redact(new Key(), page.entries[0].reference);
}
`,
            );
            const compiled = spawnSync(
                process.execPath,
                [
                    resolve('node_modules/toilscript/bin/toilscript.js'),
                    source,
                    '-o',
                    artifact,
                    '--runtime',
                    'stub',
                ],
                { encoding: 'utf8' },
            );
            expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
            const binary = readFileSync(artifact);
            __resetDbForTests();
            devDb.setCatalog(binary);
            devDb.configurePersistence(snapshot);
            const state = freshDispatchState();
            const ref: { memory: WebAssembly.Memory | null } = { memory: null };
            const loaded = await WebAssembly.instantiate(binary, buildHostImports(ref, state));
            ref.memory = loaded.instance.exports.memory as WebAssembly.Memory;
            const functions = loaded.instance.exports as unknown as Record<string, () => number>;
            state.db.functionKind = DbFunctionKind.Action;
            functions.seed();
            devDb.persist();
            const original = JSON.parse(readFileSync(snapshot, 'utf8')) as {
                events: Record<string, { v: string }[]>;
            };
            const originalPayload = Object.values(original.events)[0][0].v;
            expect(functions.getPrivate()).toBe(1);
            state.db.functionKind = DbFunctionKind.Job;
            expect(functions.count()).toBe(2);
            expect(functions.erasePrivate()).toBe(1);
            expect(functions.getPrivate()).toBe(0);
            expect(functions.getLast()).toBe('keep this'.length);
            expect(functions.count()).toBe(1);
            devDb.persist();
            expect(readFileSync(snapshot, 'utf8')).not.toContain(
                Buffer.from('personal words').toString('base64'),
            );
            // A retained ledger also masks stale payloads in an imported snapshot.
            const replay = JSON.parse(readFileSync(snapshot, 'utf8')) as typeof original;
            Object.values(replay.events)[0][0].v = originalPayload;
            writeFileSync(snapshot, JSON.stringify(replay));
            devDb.configurePersistence(snapshot); // load persisted erasure + references
            expect(functions.getPrivate()).toBe(0);
            devDb.persist();
            const scrubbed = JSON.parse(readFileSync(snapshot, 'utf8')) as typeof original;
            expect(Object.values(scrubbed.events)[0][0].v).toBe('');
            expect(functions.erasePrivate()).toBe(1);
            expect(functions.eraseOrdinary()).toBe(1);
            expect(functions.getLast()).toBe(0);
            expect(functions.count()).toBe(0);
        } finally {
            devDb.configurePersistence(null);
            __resetDbForTests();
            rmSync(root, { recursive: true, force: true });
        }
    });
});

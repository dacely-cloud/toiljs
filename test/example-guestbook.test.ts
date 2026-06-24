/**
 * The `examples/basic` Guestbook demo: a @rest controller backed by ToilDB
 * (`events` + `counter`). Each dispatch runs a FRESH wasm instance (linear
 * memory resets between requests), so the only thing that can carry a signature
 * from one request to the next is ToilDB - which is exactly what the demo shows.
 * Contrast the `Players` route, whose own comment notes "memory resets next
 * request". Skips until the example server wasm is built (`npm run build:server`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeEach } from 'vitest';

import { WasmServerModule } from '../src/devserver/index.js';
import { __resetDbForTests, configureDbPersistence } from '../src/devserver/db/index.js';

const EXAMPLE_WASM = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../examples/basic/build/server/release.wasm',
);
const haveWasm = fs.existsSync(EXAMPLE_WASM);

function load(): WasmServerModule {
    const m = new WasmServerModule(EXAMPLE_WASM);
    m.refresh();
    return m;
}
function sign(m: WasmServerModule, author: string, message: string) {
    return m.dispatch({
        method: 'POST',
        path: '/guestbook',
        headers: [
            ['host', 'localhost:3000'],
            ['content-type', 'application/json'],
        ],
        body: new TextEncoder().encode(JSON.stringify({ author, message })),
    });
}
function list(m: WasmServerModule) {
    return m.dispatch({
        method: 'GET',
        path: '/guestbook',
        headers: [['host', 'localhost:3000']],
        body: new Uint8Array(0),
    });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: { body: Uint8Array }): any => JSON.parse(Buffer.from(r.body).toString());

describe.skipIf(!haveWasm)('guestbook demo: ToilDB events + counter persist across requests', () => {
    beforeEach(() => __resetDbForTests());

    it('starts empty after a reset', () => {
        const v = json(list(load()));
        expect(v.total).toBe('0'); // i64 rides JSON as a decimal string
        expect(v.entries.length).toBe(0);
    });

    it('signatures persist across separate requests (a fresh instance each time)', () => {
        let r = sign(load(), 'Ada', 'first!');
        expect(r.status).toBe(200);
        expect(json(r).total).toBe('1');

        // A brand-new wasm instance - its memory is empty - still sees the prior
        // signature, because it lives in ToilDB, not module state. The action
        // acks with the running total; the entries list is served by the GET.
        r = sign(load(), 'Linus', 'second');
        expect(json(r).total).toBe('2');

        // The newest entries are served by GET /guestbook from the materialized
        // view that the @derive republishes after each signature (events.latest
        // is a scan, barred in the request handlers, so it runs in the derive).
        const v = json(list(load()));
        expect(v.total).toBe('2');
        expect(v.entries.length).toBe(2);
        expect(v.entries[0].author).toBe('Linus'); // events.latest is newest-first
        expect(v.entries[1].author).toBe('Ada');
        expect(v.entries[1].message).toBe('first!');
    });

    // End-to-end proof that the `server/migrations/GuestEntry.migration.ts` demo
    // actually RUNS: write an entry under the current shape, downgrade it on disk to
    // the original pre-`at` `GuestEntryV1` layout (drop the trailing u64 + re-stamp
    // with v1's schema_version), then `list()` and confirm the woven decoder ran the
    // `@migrate` - the entry comes back with the new `at` field defaulted to 0.
    it('migrates an on-disk pre-`at` entry on read (the GuestEntry.migration demo fires)', () => {
        const GUEST_ENTRY_V1_VERSION = 631968986; // layoutHash({author:string, message:string})
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-mig-'));
        const file = path.join(dir, 'devdata.json');
        try {
            // 1. sign under the CURRENT shape (author, message, at); persistence flushes it.
            configureDbPersistence(file);
            expect(sign(load(), 'Ada', 'from the old days').status).toBe(200);

            // 2. downgrade that event on disk to the v1 shape: GuestEntry encodes
            //    author + message + at(u64), so dropping the trailing 8 bytes yields a
            //    valid GuestEntryV1; re-stamp it with v1's schema_version.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const snap: any = JSON.parse(fs.readFileSync(file, 'utf8'));
            const evKey = Object.keys(snap.events)[0];
            const buf = Buffer.from(snap.events[evKey][0].v, 'base64');
            snap.events[evKey][0] = {
                v: buf.subarray(0, buf.length - 8).toString('base64'),
                sv: GUEST_ENTRY_V1_VERSION,
            };
            fs.writeFileSync(file, JSON.stringify(snap));

            // 3. reload + list: the read surfaces v1's version, so the guest's woven
            //    decoder runs the @migrate, copying author/message and defaulting at=0.
            __resetDbForTests();
            configureDbPersistence(file);
            const v = json(list(load()));
            expect(v.entries.length).toBe(1);
            expect(v.entries[0].author).toBe('Ada');
            expect(v.entries[0].message).toBe('from the old days');
            expect(String(v.entries[0].at)).toBe('0'); // the migrated-in field
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

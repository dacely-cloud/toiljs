/**
 * The `examples/basic` Guestbook demo: a @rest controller backed by ToilDB
 * (`events` + `counter`). Each dispatch runs a FRESH wasm instance (linear
 * memory resets between requests), so the only thing that can carry a signature
 * from one request to the next is ToilDB - which is exactly what the demo shows.
 * Contrast the `Players` route, whose own comment notes "memory resets next
 * request". Skips until the example server wasm is built (`npm run build:server`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeEach } from 'vitest';

import { WasmServerModule } from '../src/devserver/index.js';
import { __resetDbForTests } from '../src/devserver/database.js';

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
        // signature, because it lives in ToilDB, not module state.
        r = sign(load(), 'Linus', 'second');
        const v = json(r);
        expect(v.total).toBe('2');
        expect(v.entries.length).toBe(2);
        expect(v.entries[0].author).toBe('Linus'); // events.latest is newest-first
        expect(v.entries[1].author).toBe('Ada');
        expect(v.entries[1].message).toBe('first!');

        // A read-only GET on yet another instance sees the same persisted state.
        expect(json(list(load())).total).toBe('2');
    });
});

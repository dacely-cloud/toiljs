import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    CollectionFamily,
    DbFunctionKind,
    __resetDbForTests,
    __setDbCatalogForTests,
    buildDatabaseImports,
    configureDbPersistence,
    freshDbState,
    persistDb,
    setDbCatalog,
} from '../src/devserver/db/index.js';
import type { MemoryRef } from '../src/devserver/runtime/host.js';

const DEFAULT_CATALOG = {
    'App/users': { family: CollectionFamily.Record },
    'App/posts': { family: CollectionFamily.Record },
    'App/docs': { family: CollectionFamily.Record },
    'App/challenges': { family: CollectionFamily.Record },
    'App/pages': { family: CollectionFamily.View },
    'App/feed': { family: CollectionFamily.Events },
    'App/likes': { family: CollectionFamily.Counter },
    'App/rooms': { family: CollectionFamily.Membership },
    'App/usernames': { family: CollectionFamily.Unique },
    'App/seats': { family: CollectionFamily.Capacity },
    'App/tickets': { family: CollectionFamily.Capacity },
};

function setupRaw() {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const ref: MemoryRef = { memory };
    const db = freshDbState();
    const imports = buildDatabaseImports(ref, db);
    const buf = Buffer.from(memory.buffer);
    return { ref, db, imports, buf };
}

function setup() {
    __setDbCatalogForTests(DEFAULT_CATALOG);
    return setupRaw();
}

/** Write bytes at `offset`, returning the `[ptr, len]` pair the imports expect. */
function put(buf: Buffer, offset: number, data: string): [number, number] {
    const b = Buffer.from(data);
    b.copy(buf, offset);
    return [offset, b.length];
}

function resolve(
    imports: Record<string, (...a: number[]) => number>,
    buf: Buffer,
    name: string,
): number {
    const [p, l] = put(buf, 0, name);
    expect(imports['data.resolve_collection'](p, l, 16)).toBe(0);
    return buf.readUInt32LE(16);
}

function wasmWithSection(name: string, payload: Uint8Array): Buffer {
    const nameBytes = Buffer.from(name);
    const sectionPayload = Buffer.concat([
        Buffer.from([nameBytes.length]),
        nameBytes,
        Buffer.from(payload),
    ]);
    return Buffer.concat([
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, sectionPayload.length]),
        sectionPayload,
    ]);
}

afterEach(() => {
    __resetDbForTests();
});

describe('toildb dev emulator (record family)', () => {
    it('rejects unknown catalog collections instead of minting arbitrary handles', () => {
        const { imports, buf } = setup();
        const [p, l] = put(buf, 0, 'App/missing');
        buf.writeUInt32LE(0xdeadbeef, 16);
        expect(imports['data.resolve_collection'](p, l, 16)).toBe(-1070);
        expect(buf.readUInt32LE(16)).toBe(0xdeadbeef);
    });

    it('rejects a present but malformed catalog section', () => {
        setDbCatalog(wasmWithSection('toildb.catalog', Buffer.from([0xff, 0x00, 0xde, 0xad])));
        const { imports, buf } = setupRaw();
        const [p, l] = put(buf, 0, 'App/users');

        expect(imports['data.resolve_collection'](p, l, 16)).toBe(-1070);
    });

    it('rejects handles used with the wrong collection family', () => {
        const { imports, buf } = setup();
        const users = resolve(imports, buf, 'App/users');
        const likes = resolve(imports, buf, 'App/likes');
        const [kPtr, kLen] = put(buf, 32, 'k');
        const [vPtr, vLen] = put(buf, 48, 'v');

        expect(imports['data.counter_add'](users, kPtr, kLen, 1, 0)).toBe(-1010);
        expect(imports['data.create'](likes, kPtr, kLen, vPtr, vLen, 0)).toBe(-1010);
    });

    it('query-kind dispatch denies writes and write_allowed is false', () => {
        const { imports, buf, db } = setup();
        db.functionKind = DbFunctionKind.Query;
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'u1');
        const [vPtr, vLen] = put(buf, 48, 'hello');

        expect(imports['data.write_allowed']()).toBe(0);
        expect(imports['data.get'](h, kPtr, kLen)).toBe(-2);
        expect(imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0)).toBe(-1011);
    });

    it('resolve + create + get + take_result round-trips', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'u1');
        const [vPtr, vLen] = put(buf, 48, 'hello');

        expect(imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0)).toBe(0);
        expect(imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0)).toBe(-1003); // AlreadyExists
        expect(imports['data.exists'](h, kPtr, kLen)).toBe(1);

        expect(imports['data.get'](h, kPtr, kLen)).toBe(5);
        expect(imports['data.take_result'](64, 64)).toBe(5);
        expect(buf.toString('utf8', 64, 69)).toBe('hello');
    });

    it('patch updates and a following get sees the new value', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'u1');
        const [vPtr, vLen] = put(buf, 48, 'hello');
        imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0);

        const [pPtr, pLen] = put(buf, 80, 'world!');
        expect(imports['data.patch'](h, kPtr, kLen, pPtr, pLen, 0)).toBe(6);
        expect(imports['data.get'](h, kPtr, kLen)).toBe(6);
        imports['data.take_result'](128, 64);
        expect(buf.toString('utf8', 128, 134)).toBe('world!');
    });

    it('record patch idempotency replays and rejects request mismatch', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'u1');
        const [vPtr, vLen] = put(buf, 48, 'hello');
        const [idemPtr] = put(buf, 64, '1234567890abcdef');
        imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0);

        const [pPtr, pLen] = put(buf, 96, 'world!');
        expect(imports['data.patch'](h, kPtr, kLen, pPtr, pLen, idemPtr)).toBe(6);
        expect(imports['data.patch'](h, kPtr, kLen, pPtr, pLen, idemPtr)).toBe(6);
        expect(imports['data.take_result'](128, 64)).toBe(6);
        expect(buf.toString('utf8', 128, 134)).toBe('world!');

        const [otherPtr, otherLen] = put(buf, 160, 'again!');
        expect(imports['data.patch'](h, kPtr, kLen, otherPtr, otherLen, idemPtr)).toBe(-1004);
        expect(imports['data.get'](h, kPtr, kLen)).toBe(6);
        expect(imports['data.take_result'](192, 64)).toBe(6);
        expect(buf.toString('utf8', 192, 198)).toBe('world!');
    });

    it('patch on a missing key is NotFound', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'ghost');
        const [pPtr, pLen] = put(buf, 48, 'x');
        expect(imports['data.patch'](h, kPtr, kLen, pPtr, pLen, 0)).toBe(-2); // NotFound -> ABSENT
    });

    it('consume-once get_delete deletes exactly once', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/challenges');
        const [kPtr, kLen] = put(buf, 32, 'chal');
        const [vPtr, vLen] = put(buf, 48, 'nonce');
        imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0);

        expect(imports['data.get_delete'](h, kPtr, kLen, 0)).toBe(5);
        imports['data.take_result'](64, 64);
        expect(buf.toString('utf8', 64, 69)).toBe('nonce');
        // replay defeated
        expect(imports['data.get_delete'](h, kPtr, kLen, 0)).toBe(-2);
    });

    it('record get_delete idempotency replays the consumed value', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/challenges');
        const [kPtr, kLen] = put(buf, 32, 'chal');
        const [vPtr, vLen] = put(buf, 48, 'nonce');
        const [idemPtr] = put(buf, 80, 'consume-idem-001');
        imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0);

        expect(imports['data.get_delete'](h, kPtr, kLen, idemPtr)).toBe(5);
        expect(imports['data.take_result'](96, 64)).toBe(5);
        expect(buf.toString('utf8', 96, 101)).toBe('nonce');

        expect(imports['data.get_delete'](h, kPtr, kLen, idemPtr)).toBe(5);
        expect(imports['data.take_result'](128, 64)).toBe(5);
        expect(buf.toString('utf8', 128, 133)).toBe('nonce');
        expect(imports['data.get'](h, kPtr, kLen)).toBe(-2);
    });

    it('absent / invalid handle / buffer-too-small return the edge codes', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'k');

        expect(imports['data.get'](h, kPtr, kLen)).toBe(-2); // absent
        expect(imports['data.get'](999, kPtr, kLen)).toBe(-1001); // invalid handle

        const [vPtr, vLen] = put(buf, 48, 'bigvalue');
        imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0);
        imports['data.get'](h, kPtr, kLen);
        expect(imports['data.take_result'](64, 2)).toBe(-1); // too small, stash kept
        expect(imports['data.take_result'](64, 64)).toBe(8); // retry succeeds
    });

    it('unique claim: Claimed / AlreadyOwnedByCaller / AlreadyClaimed', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/usernames');
        const [kPtr, kLen] = put(buf, 32, 'ada');
        const [u1Ptr, u1Len] = put(buf, 48, 'user_1');
        const [u2Ptr, u2Len] = put(buf, 64, 'user_2');

        expect(imports['data.unique_claim'](h, kPtr, kLen, u1Ptr, u1Len, 0)).toBe(0); // Claimed
        expect(imports['data.unique_claim'](h, kPtr, kLen, u1Ptr, u1Len, 0)).toBe(2); // AlreadyOwnedByCaller
        // a different owner -> AlreadyClaimed, current owner stashed
        expect(imports['data.unique_claim'](h, kPtr, kLen, u2Ptr, u2Len, 0)).toBe(1);
        expect(imports['data.take_result'](128, 64)).toBe(6);
        expect(buf.toString('utf8', 128, 134)).toBe('user_1');

        // lookup returns the owner
        expect(imports['data.unique_lookup'](h, kPtr, kLen)).toBe(6);
        imports['data.take_result'](200, 64);
        expect(buf.toString('utf8', 200, 206)).toBe('user_1');
    });

    it('unique claim: same owner must replay only with the same idempotency key', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/usernames');
        const [kPtr, kLen] = put(buf, 32, 'grace');
        const [u1Ptr, u1Len] = put(buf, 48, 'user_1');
        const [idem1Ptr] = put(buf, 80, 'idem-claim-0001');
        const [idem2Ptr] = put(buf, 112, 'idem-claim-0002');

        expect(imports['data.unique_claim'](h, kPtr, kLen, u1Ptr, u1Len, idem1Ptr)).toBe(0);
        expect(imports['data.unique_claim'](h, kPtr, kLen, u1Ptr, u1Len, idem1Ptr)).toBe(2);
        expect(imports['data.unique_claim'](h, kPtr, kLen, u1Ptr, u1Len, idem2Ptr)).toBe(-1004);
    });

    it('unique release: only the owner may release', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/usernames');
        const [kPtr, kLen] = put(buf, 32, 'ada');
        const [u1Ptr, u1Len] = put(buf, 48, 'user_1');
        const [u2Ptr, u2Len] = put(buf, 64, 'user_2');
        imports['data.unique_claim'](h, kPtr, kLen, u1Ptr, u1Len, 0);

        expect(imports['data.unique_release'](h, kPtr, kLen, u2Ptr, u2Len, 0)).toBe(-1004); // not owner
        expect(imports['data.unique_release'](h, kPtr, kLen, u1Ptr, u1Len, 0)).toBe(0); // owner releases
        expect(imports['data.unique_lookup'](h, kPtr, kLen)).toBe(-2); // gone
    });

    it('get_many: framed multi-get preserves order with present/absent', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/users');
        const [k1, l1] = put(buf, 32, 'u1');
        const [vA, lA] = put(buf, 48, 'AA');
        imports['data.create'](h, k1, l1, vA, lA, 0);
        const [k2, l2] = put(buf, 64, 'u2');
        const [vB, lB] = put(buf, 80, 'BB');
        imports['data.create'](h, k2, l2, vB, lB, 0);

        // keys blob at 128: count=3, then "u1","u3","u2" (u3 absent).
        let o = 128;
        o = buf.writeUInt32LE(3, o);
        for (const k of ['u1', 'u3', 'u2']) {
            o = buf.writeUInt32LE(2, o);
            o += buf.write(k, o, 'latin1');
        }
        const n = imports['data.get_many'](h, 128, o - 128);
        expect(n).toBeGreaterThan(0);
        expect(imports['data.take_result'](256, 256)).toBe(n);

        let p = 256;
        const count = buf.readUInt32LE(p);
        p += 4;
        expect(count).toBe(3);
        const got: (string | null)[] = [];
        for (let i = 0; i < count; i++) {
            const present = buf.readUInt8(p);
            p += 1;
            if (present === 0) {
                got.push(null);
                continue;
            }
            p += 4; // per-item schema_version (0 in dev)
            const len = buf.readUInt32LE(p);
            p += 4;
            got.push(buf.toString('utf8', p, p + len));
            p += len;
        }
        expect(got).toEqual(['AA', null, 'BB']);

        expect(imports['data.get_many'](999, 128, o - 128)).toBe(-1001); // invalid handle
    });

    it('membership: add/contains/remove + sorted framed list', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/rooms');
        const [sPtr, sLen] = put(buf, 32, 'room1');

        const [aPtr, aLen] = put(buf, 48, 'alice');
        const [bPtr, bLen] = put(buf, 64, 'bob');
        expect(imports['data.membership_contains'](h, sPtr, sLen, aPtr, aLen)).toBe(0); // absent
        expect(imports['data.membership_add'](h, sPtr, sLen, aPtr, aLen, 0)).toBe(0);
        expect(imports['data.membership_add'](h, sPtr, sLen, bPtr, bLen, 0)).toBe(0);
        expect(imports['data.membership_add'](h, sPtr, sLen, aPtr, aLen, 0)).toBe(0); // idempotent
        expect(imports['data.membership_contains'](h, sPtr, sLen, aPtr, aLen)).toBe(1);

        // list -> framed u32 count + per member (u32 len + bytes), sorted (alice, bob).
        const total = imports['data.membership_list'](h, sPtr, sLen, 10);
        expect(imports['data.take_result'](128, 128)).toBe(total);
        let off = 128;
        const count = buf.readUInt32LE(off);
        off += 4;
        expect(count).toBe(2);
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
            off += 4; // per-item schema_version (0 in dev)
            const len = buf.readUInt32LE(off);
            off += 4;
            out.push(buf.toString('utf8', off, off + len));
            off += len;
        }
        expect(out).toEqual(['alice', 'bob']);

        // remove is idempotent; the member is gone.
        expect(imports['data.membership_remove'](h, sPtr, sLen, aPtr, aLen, 0)).toBe(0);
        expect(imports['data.membership_remove'](h, sPtr, sLen, aPtr, aLen, 0)).toBe(0);
        expect(imports['data.membership_contains'](h, sPtr, sLen, aPtr, aLen)).toBe(0);
        expect(imports['data.membership_contains'](h, sPtr, sLen, bPtr, bLen)).toBe(1);

        expect(imports['data.membership_add'](999, sPtr, sLen, aPtr, aLen, 0)).toBe(-1001); // bad handle
    });

    it('view: publish overwrites and get reads the latest (or absent)', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/pages');
        const [kPtr, kLen] = put(buf, 32, 'home');

        // absent before any publish
        expect(imports['data.view_get'](h, kPtr, kLen)).toBe(-2);

        const [v1Ptr, v1Len] = put(buf, 48, '<v1>');
        expect(imports['data.view_publish'](h, kPtr, kLen, v1Ptr, v1Len, 0)).toBe(0);
        expect(imports['data.view_get'](h, kPtr, kLen)).toBe(4);
        expect(imports['data.take_result'](64, 64)).toBe(4);
        expect(buf.toString('utf8', 64, 68)).toBe('<v1>');

        // republish overwrites (latest wins)
        const [v2Ptr, v2Len] = put(buf, 80, '<page2>');
        expect(imports['data.view_publish'](h, kPtr, kLen, v2Ptr, v2Len, 0)).toBe(0);
        expect(imports['data.view_get'](h, kPtr, kLen)).toBe(7);
        imports['data.take_result'](128, 64);
        expect(buf.toString('utf8', 128, 135)).toBe('<page2>');

        expect(imports['data.view_get'](999, kPtr, kLen)).toBe(-1001); // invalid handle
    });

    it('counter: add accumulates (saturating i64) and get reads the sum', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/likes');
        const [kPtr, kLen] = put(buf, 32, 'post1');

        // empty counter reads as 0 (8 LE bytes), never absent.
        expect(imports['data.counter_get'](h, kPtr, kLen)).toBe(8);
        expect(imports['data.take_result'](64, 8)).toBe(8);
        expect(buf.readBigInt64LE(64)).toBe(0n);

        expect(imports['data.counter_add'](h, kPtr, kLen, 5, 0)).toBe(0);
        expect(imports['data.counter_add'](h, kPtr, kLen, -2, 0)).toBe(0);
        expect(imports['data.counter_get'](h, kPtr, kLen)).toBe(8);
        imports['data.take_result'](72, 8);
        expect(buf.readBigInt64LE(72)).toBe(3n);

        const [idemPtr] = put(buf, 96, 'counter-idem-001');
        expect(imports['data.counter_add'](h, kPtr, kLen, 7, idemPtr)).toBe(0);
        expect(imports['data.counter_add'](h, kPtr, kLen, 7, idemPtr)).toBe(0);
        expect(imports['data.counter_add'](h, kPtr, kLen, 8, idemPtr)).toBe(-1004);
        expect(imports['data.counter_get'](h, kPtr, kLen)).toBe(8);
        imports['data.take_result'](104, 8);
        expect(buf.readBigInt64LE(104)).toBe(10n);

        // invalid handle still rejected
        expect(imports['data.counter_add'](999, kPtr, kLen, 1, 0)).toBe(-1001);
    });

    it('events: append then latest returns newest-first, bounded by limit', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/feed');
        const [kPtr, kLen] = put(buf, 32, 'room1');

        for (let i = 0; i < 4; i++) {
            const [eP, eL] = put(buf, 48, `ev${String(i)}`);
            expect(imports['data.append'](h, kPtr, kLen, eP, eL, 0)).toBe(0);
        }

        // latest(2) -> framed: u32 count=2, then [len+bytes] newest-first (ev3, ev2).
        const total = imports['data.latest'](h, kPtr, kLen, 2);
        expect(total).toBeGreaterThan(0);
        expect(imports['data.take_result'](128, 128)).toBe(total);
        let off = 128;
        const count = buf.readUInt32LE(off);
        off += 4;
        expect(count).toBe(2);
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
            off += 4; // per-item schema_version (0 in dev)
            const len = buf.readUInt32LE(off);
            off += 4;
            out.push(buf.toString('utf8', off, off + len));
            off += len;
        }
        expect(out).toEqual(['ev3', 'ev2']);

        // an empty stream frames an empty list (count 0, 4 bytes), never absent.
        const [k2P, k2L] = put(buf, 256, 'empty');
        expect(imports['data.latest'](h, k2P, k2L, 10)).toBe(4);
        imports['data.take_result'](300, 8);
        expect(buf.readUInt32LE(300)).toBe(0);
    });

    it('collections are isolated (no key aliasing)', () => {
        const { imports, buf } = setup();
        const users = resolve(imports, buf, 'App/users');
        const [n2p, n2l] = put(buf, 256, 'App/posts');
        expect(imports['data.resolve_collection'](n2p, n2l, 260)).toBe(0);
        const posts = buf.readUInt32LE(260);

        const [kPtr, kLen] = put(buf, 32, 'x');
        const [vPtr, vLen] = put(buf, 48, 'inusers');
        imports['data.create'](users, kPtr, kLen, vPtr, vLen, 0);
        // the same logical key in another collection is absent.
        expect(imports['data.get'](posts, kPtr, kLen)).toBe(-2);
    });

    it('append_once dedups on eventId; enqueue replaces an existing record', () => {
        const { imports, buf } = setup();
        const feed = resolve(imports, buf, 'App/feed');
        const [kPtr, kLen] = put(buf, 32, 'room1');
        const [idPtr, idLen] = put(buf, 64, 'evt-1');
        const [evPtr, evLen] = put(buf, 96, 'hello');
        // first appendOnce appends (1); the same id is a no-op (0); a new id appends (1).
        expect(imports['data.append_once'](feed, kPtr, kLen, idPtr, idLen, evPtr, evLen)).toBe(1);
        expect(imports['data.append_once'](feed, kPtr, kLen, idPtr, idLen, evPtr, evLen)).toBe(0);
        const [id2P, id2L] = put(buf, 128, 'evt-2');
        expect(imports['data.append_once'](feed, kPtr, kLen, id2P, id2L, evPtr, evLen)).toBe(1);
        const [appendIdemPtr] = put(buf, 144, 'append-idem-0001');
        expect(imports['data.append'](feed, kPtr, kLen, evPtr, evLen, appendIdemPtr)).toBe(0);
        expect(imports['data.append'](feed, kPtr, kLen, evPtr, evLen, appendIdemPtr)).toBe(0);
        // latest frames exactly 2 events (the duplicate did not double-append).
        const total = imports['data.latest'](feed, kPtr, kLen, 10);
        expect(total).toBeGreaterThan(0);
        imports['data.take_result'](512, total);
        expect(buf.readUInt32LE(512)).toBe(3);

        // enqueue: absent -> ABSENT (-2); after create -> replaces (0); get sees the new value.
        const docs = resolve(imports, buf, 'App/docs');
        const [dkP, dkL] = put(buf, 160, 'doc1');
        const [v1P, v1L] = put(buf, 192, 'AAAA');
        expect(imports['data.enqueue'](docs, dkP, dkL, v1P, v1L, 0)).toBe(-2);
        expect(imports['data.create'](docs, dkP, dkL, v1P, v1L, 0)).toBe(0);
        const [v2P, v2L] = put(buf, 224, 'BBBB');
        expect(imports['data.enqueue'](docs, dkP, dkL, v2P, v2L, 0)).toBe(0);
        expect(imports['data.get'](docs, dkP, dkL)).toBe(4);
        imports['data.take_result'](256, 4);
        expect(buf.toString('utf8', 256, 260)).toBe('BBBB');
    });
});

type Imports = Record<string, (...args: number[]) => number>;

describe('toildb dev emulator (capacity family)', () => {
    // Pull the last stashed i64 available into the buffer and read it.
    function avail(imports: Imports, buf: Buffer, h: number, kPtr: number, kLen: number): bigint {
        expect(imports['data.capacity_available'](h, kPtr, kLen)).toBe(8);
        expect(imports['data.take_result'](512, 16)).toBe(8);
        return buf.readBigInt64LE(512);
    }

    it('set_total / reserve / confirm / cancel keep the ledger consistent', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/seats');
        const [kPtr, kLen] = put(buf, 32, 'showA');

        // an empty ledger reads 0 available, never absent.
        expect(avail(imports, buf, h, kPtr, kLen)).toBe(0n);

        // restock to 10.
        expect(imports['data.capacity_set_total'](h, kPtr, kLen, 10, 0)).toBe(0);
        expect(avail(imports, buf, h, kPtr, kLen)).toBe(10n);

        // reserve 3 -> a u64 id (> 0) is stashed, available drops to 7.
        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 3, 60000, 0)).toBe(8);
        expect(imports['data.take_result'](512, 16)).toBe(8);
        const id = buf.readBigUInt64LE(512);
        expect(id > 0n).toBe(true);
        expect(avail(imports, buf, h, kPtr, kLen)).toBe(7n);

        const [idemPtr] = put(buf, 64, 'reserve-idem-001');
        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 2, 60000, idemPtr)).toBe(8);
        expect(imports['data.take_result'](520, 16)).toBe(8);
        const idemId = buf.readBigUInt64LE(520);
        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 2, 60000, idemPtr)).toBe(8);
        expect(imports['data.take_result'](528, 16)).toBe(8);
        expect(buf.readBigUInt64LE(528)).toBe(idemId);
        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 1, 60000, idemPtr)).toBe(-1004);
        expect(avail(imports, buf, h, kPtr, kLen)).toBe(5n);

        // cancel returns the hold -> back to 10; a double-cancel is a no-op.
        expect(imports['data.capacity_cancel'](h, kPtr, kLen, Number(id), 0)).toBe(1);
        expect(avail(imports, buf, h, kPtr, kLen)).toBe(8n);
        expect(imports['data.capacity_cancel'](h, kPtr, kLen, Number(id), 0)).toBe(0);

        // reserve 4 then confirm -> a permanent consume; available holds at 6.
        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 4, 60000, 0)).toBe(8);
        imports['data.take_result'](512, 16);
        const id2 = Number(buf.readBigUInt64LE(512));
        expect(imports['data.capacity_confirm'](h, kPtr, kLen, id2, 0)).toBe(1);
        expect(avail(imports, buf, h, kPtr, kLen)).toBe(4n);
        // a confirmed sale cannot be cancelled (0); re-confirm is idempotent (1).
        expect(imports['data.capacity_cancel'](h, kPtr, kLen, id2, 0)).toBe(0);
        expect(imports['data.capacity_confirm'](h, kPtr, kLen, id2, 0)).toBe(1);
    });

    it('never oversells (a reserve beyond available is refused)', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/tickets');
        const [kPtr, kLen] = put(buf, 32, 'vip');
        imports['data.capacity_set_total'](h, kPtr, kLen, 5, 0);

        // a hold for all 5 succeeds; a further hold for 1 is refused (-2 -> guest 0).
        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 5, 60000, 0)).toBe(8);
        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 1, 60000, 0)).toBe(-2);
        // a non-positive amount is a typed error (BadAmount), invalid handle rejected.
        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 0, 60000, 0)).toBe(-1006);
        expect(imports['data.capacity_available'](999, kPtr, kLen)).toBe(-1001);
    });

    it('does not cache an idempotent insufficient reserve forever', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/tickets');
        const [kPtr, kLen] = put(buf, 32, 'late-restock');
        const [idemPtr] = put(buf, 64, 'reserve-idem-001');

        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 1, 60000, idemPtr)).toBe(-2);
        expect(imports['data.capacity_set_total'](h, kPtr, kLen, 1, 0)).toBe(0);
        expect(imports['data.capacity_reserve'](h, kPtr, kLen, 1, 60000, idemPtr)).toBe(8);
    });
});

describe('toildb dev emulator (migration + persistence)', () => {
    const rsv = (imports: Imports): bigint =>
        (imports['data.result_schema_version'] as () => bigint)();

    it('stamps writes with the catalog schema_version and surfaces it on read', () => {
        const { imports, buf } = setup();
        __setDbCatalogForTests({ 'App/users': 0x1234 });
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'u1');
        const [vPtr, vLen] = put(buf, 64, 'data');
        imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0);
        expect(imports['data.get'](h, kPtr, kLen)).toBe(4);
        expect(rsv(imports)).toBe(0x1234n); // the woven decoder dispatches on this
    });

    it('an evolved @data type leaves old rows stamped with the OLD version', () => {
        const { imports, buf } = setup();
        __setDbCatalogForTests({ 'App/users': 100 }); // version A
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'u1');
        const [vPtr, vLen] = put(buf, 64, 'old');
        imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0);
        // the @data type evolves + the wasm rebuilds -> the catalog version changes.
        __setDbCatalogForTests({ 'App/users': 200 }); // version B
        // a read of the existing row still reports the OLD version -> guest migrates it.
        imports['data.get'](h, kPtr, kLen);
        expect(rsv(imports)).toBe(100n);
        // a NEW write stamps the current version.
        const [k2, kl2] = put(buf, 96, 'u2');
        imports['data.create'](h, k2, kl2, vPtr, vLen, 0);
        imports['data.get'](h, k2, kl2);
        expect(rsv(imports)).toBe(200n);
    });

    it('persists data + versions to disk and reloads them', () => {
        const dir = mkdtempSync(join(tmpdir(), 'toildb-'));
        const file = join(dir, 'devdata.json');
        try {
            const a = setup();
            __setDbCatalogForTests({ 'App/users': 777 });
            configureDbPersistence(file);
            const h = resolve(a.imports, a.buf, 'App/users');
            const [kPtr, kLen] = put(a.buf, 32, 'u1');
            const [vPtr, vLen] = put(a.buf, 64, 'persisted');
            a.imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0);
            persistDb();

            // simulate a restart: wipe memory + catalog, then reload from disk.
            __resetDbForTests();
            configureDbPersistence(file);
            const b = setup();
            const h2 = resolve(b.imports, b.buf, 'App/users');
            const [k2, kl2] = put(b.buf, 32, 'u1');
            expect(b.imports['data.get'](h2, k2, kl2)).toBe(9); // "persisted" survived restart
            expect(rsv(b.imports)).toBe(777n); // and so did its schema_version stamp
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('persists counter idempotency across devserver restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'toildb-'));
        const file = join(dir, 'devdata.json');
        try {
            const a = setup();
            configureDbPersistence(file);
            const h = resolve(a.imports, a.buf, 'App/likes');
            const [kPtr, kLen] = put(a.buf, 32, 'post-1');
            const [idemPtr] = put(a.buf, 64, 'counter-idem-001');
            expect(a.imports['data.counter_add'](h, kPtr, kLen, 7, idemPtr)).toBe(0);
            persistDb();

            __resetDbForTests();
            configureDbPersistence(file);
            const b = setup();
            const h2 = resolve(b.imports, b.buf, 'App/likes');
            const [k2, kl2] = put(b.buf, 32, 'post-1');
            const [idem2] = put(b.buf, 64, 'counter-idem-001');
            expect(b.imports['data.counter_add'](h2, k2, kl2, 7, idem2)).toBe(0);
            expect(b.imports['data.counter_add'](h2, k2, kl2, 8, idem2)).toBe(-1004);
            expect(b.imports['data.counter_get'](h2, k2, kl2)).toBe(8);
            expect(b.imports['data.take_result'](96, 8)).toBe(8);
            expect(b.buf.readBigInt64LE(96)).toBe(7n);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('persists unique claim idempotency across devserver restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'toildb-'));
        const file = join(dir, 'devdata.json');
        try {
            const a = setup();
            configureDbPersistence(file);
            const h = resolve(a.imports, a.buf, 'App/usernames');
            const [kPtr, kLen] = put(a.buf, 32, 'hopper');
            const [u1Ptr, u1Len] = put(a.buf, 48, 'user_1');
            const [idemPtr] = put(a.buf, 80, 'idem-claim-0001');
            expect(a.imports['data.unique_claim'](h, kPtr, kLen, u1Ptr, u1Len, idemPtr)).toBe(0);
            persistDb();

            __resetDbForTests();
            configureDbPersistence(file);
            const b = setup();
            const h2 = resolve(b.imports, b.buf, 'App/usernames');
            const [k2, kl2] = put(b.buf, 32, 'hopper');
            const [u2, u2l] = put(b.buf, 48, 'user_1');
            const [sameIdem] = put(b.buf, 80, 'idem-claim-0001');
            const [otherIdem] = put(b.buf, 112, 'idem-claim-0002');
            expect(b.imports['data.unique_claim'](h2, k2, kl2, u2, u2l, sameIdem)).toBe(2);
            expect(b.imports['data.unique_claim'](h2, k2, kl2, u2, u2l, otherIdem)).toBe(-1004);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('replays idempotent capacity reservations across devserver restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'toildb-'));
        const file = join(dir, 'devdata.json');
        try {
            const a = setup();
            configureDbPersistence(file);
            const h = resolve(a.imports, a.buf, 'App/seats');
            const [kPtr, kLen] = put(a.buf, 32, 'showB');
            const [idemPtr] = put(a.buf, 64, 'reserve-idem-001');
            expect(a.imports['data.capacity_set_total'](h, kPtr, kLen, 3, 0)).toBe(0);
            expect(a.imports['data.capacity_reserve'](h, kPtr, kLen, 2, 60000, idemPtr)).toBe(8);
            expect(a.imports['data.take_result'](96, 16)).toBe(8);
            const firstId = a.buf.readBigUInt64LE(96);
            persistDb();

            __resetDbForTests();
            configureDbPersistence(file);
            const b = setup();
            const h2 = resolve(b.imports, b.buf, 'App/seats');
            const [k2, kl2] = put(b.buf, 32, 'showB');
            const [idem2] = put(b.buf, 64, 'reserve-idem-001');
            expect(b.imports['data.capacity_reserve'](h2, k2, kl2, 2, 60000, idem2)).toBe(8);
            expect(b.imports['data.take_result'](96, 16)).toBe(8);
            expect(b.buf.readBigUInt64LE(96)).toBe(firstId);
            expect(b.imports['data.capacity_available'](h2, k2, kl2)).toBe(8);
            expect(b.imports['data.take_result'](112, 16)).toBe(8);
            expect(b.buf.readBigInt64LE(112)).toBe(1n);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

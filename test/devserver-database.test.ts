import { afterEach, describe, expect, it } from 'vitest';

import { __resetDbForTests, buildDatabaseImports, freshDbState } from '../src/devserver/database.js';
import type { MemoryRef } from '../src/devserver/host.js';

function setup() {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const ref: MemoryRef = { memory };
    const db = freshDbState();
    const imports = buildDatabaseImports(ref, db);
    const buf = Buffer.from(memory.buffer);
    return { ref, db, imports, buf };
}

/** Write bytes at `offset`, returning the `[ptr, len]` pair the imports expect. */
function put(buf: Buffer, offset: number, data: string): [number, number] {
    const b = Buffer.from(data);
    b.copy(buf, offset);
    return [offset, b.length];
}

function resolve(imports: Record<string, (...a: number[]) => number>, buf: Buffer, name: string): number {
    const [p, l] = put(buf, 0, name);
    expect(imports['data.resolve_collection'](p, l, 16)).toBe(0);
    return buf.readUInt32LE(16);
}

afterEach(() => {
    __resetDbForTests();
});

describe('toildb dev emulator (record family)', () => {
    it('resolve + create + get + take_result round-trips', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'u1');
        const [vPtr, vLen] = put(buf, 48, 'hello');

        expect(imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0)).toBe(0);
        expect(imports['data.create'](h, kPtr, kLen, vPtr, vLen, 0)).toBe(-1000); // AlreadyExists
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

    it('patch on a missing key is NotFound', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/users');
        const [kPtr, kLen] = put(buf, 32, 'ghost');
        const [pPtr, pLen] = put(buf, 48, 'x');
        expect(imports['data.patch'](h, kPtr, kLen, pPtr, pLen, 0)).toBe(-1000);
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

    it('unique release: only the owner may release', () => {
        const { imports, buf } = setup();
        const h = resolve(imports, buf, 'App/usernames');
        const [kPtr, kLen] = put(buf, 32, 'ada');
        const [u1Ptr, u1Len] = put(buf, 48, 'user_1');
        const [u2Ptr, u2Len] = put(buf, 64, 'user_2');
        imports['data.unique_claim'](h, kPtr, kLen, u1Ptr, u1Len, 0);

        expect(imports['data.unique_release'](h, kPtr, kLen, u2Ptr, u2Len, 0)).toBe(-1000); // not owner
        expect(imports['data.unique_release'](h, kPtr, kLen, u1Ptr, u1Len, 0)).toBe(0); // owner releases
        expect(imports['data.unique_lookup'](h, kPtr, kLen)).toBe(-2); // gone
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
});

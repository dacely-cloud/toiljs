/**
 * DEV emulation of the ToilDB record-family data API (`env::data.*`).
 *
 * The compiler-emitted guest (`@database` + `App.users.get/create/...`) calls
 * these; under `toiljs dev` we back them with a single-process in-memory store.
 * The production edge backs the SAME imports with ScyllaDB via the off-core
 * "scylla rail" (toil-backend). The wire ABI mirrors the edge exactly
 * (toildb/ABI.md): every byte region is a (ptr,len) into guest memory; returns
 * are `>= 0` success (a length/handle/flag), `-1` too-small, `-2` absent,
 * `<= -1000` a typed error (`-(1000+TDLnnn)`); variable-length results use the
 * two-step `take_result` pull.
 *
 * This is a DEV store: single-process, single-tenant, lost on restart - never a
 * production path. Record family only (get/exists/create/patch/delete/
 * get_delete + resolve/take_result); other families land with their host shims.
 */

import type { MemoryRef } from './host.js';

/** Process-lifetime store: `"collection\0keyLatin1"` -> value. Shared across dispatches. */
const STORE = new Map<string, Buffer>();
/** View family: `"collection\0key"` -> the latest published view blob. */
const VIEWS = new Map<string, Buffer>();
/** Membership family: `"collection\0setKey"` -> (memberLatin1 -> member bytes). */
const MEMBERS = new Map<string, Map<string, Buffer>>();
/** Counter family: `"collection\0key"` -> saturating i64 sum of deltas. */
const COUNTERS = new Map<string, bigint>();
/** Events family: `"collection\0key"` -> append-ordered event blobs (oldest first). */
const EVENTS = new Map<string, Buffer[]>();

const MAX_NAME = 512;
const MAX_KEY = 4096;
const MAX_VALUE = 256 * 1024;

// i64 saturation bounds (the edge `MemEngine`/`ScyllaEngine` counters are i64).
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
function satI64(v: bigint): bigint {
    return v < I64_MIN ? I64_MIN : v > I64_MAX ? I64_MAX : v;
}

// Return codes, mirroring `toildb::observe::diagnostics`.
const ABSENT = -2;
const TOO_SMALL = -1;
const INVALID_HANDLE = -1001; // -(1000 + TDL001)
const PRODUCT_ERR = -1000; // AlreadyExists / NotFound / Conflict (TDL000)

/** Per-request data state: resolved handles + the last variable-length result. */
export interface DbDevState {
    handles: string[];
    lastResult: Buffer | null;
}

export function freshDbState(): DbDevState {
    return { handles: [], lastResult: null };
}

function mem(ref: MemoryRef): Buffer {
    if (!ref.memory) throw new Error('data host import called before memory was bound');
    return Buffer.from(ref.memory.buffer);
}

/** Bounds-checked read that COPIES out of guest memory (the buffer is reused). */
function readCopy(ref: MemoryRef, ptr: number, len: number): Buffer {
    const m = mem(ref);
    if (ptr < 0 || len < 0 || ptr + len > m.length)
        throw new Error(`data read out of bounds: ptr=${String(ptr)} len=${String(len)}`);
    return Buffer.from(m.subarray(ptr, ptr + len));
}

function storeKey(collection: string, key: Buffer): string {
    return collection + '\0' + key.toString('latin1');
}

function collOf(db: DbDevState, handle: number): string | null {
    return handle >= 0 && handle < db.handles.length ? db.handles[handle] : null;
}

export function buildDatabaseImports(
    ref: MemoryRef,
    db: DbDevState,
): Record<string, (...args: number[]) => number> {
    return {
        'data.resolve_collection': (
            namePtr: number,
            nameLen: number,
            outHandlePtr: number,
        ): number => {
            if (nameLen < 0 || nameLen > MAX_NAME)
                throw new Error('data: collection name too long');
            const name = readCopy(ref, namePtr, nameLen).toString('utf8');
            const handle = db.handles.length;
            db.handles.push(name);
            const m = mem(ref);
            if (outHandlePtr < 0 || outHandlePtr + 4 > m.length)
                throw new Error('data: resolve out-handle out of bounds');
            m.writeUInt32LE(handle, outHandlePtr);
            return 0;
        },

        'data.get': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (keyLen > MAX_KEY) throw new Error('data: key too long');
            const v = STORE.get(storeKey(coll, readCopy(ref, keyPtr, keyLen)));
            if (v === undefined) return ABSENT;
            db.lastResult = v;
            return v.length;
        },

        // Bounded multi-get. Keys blob: u32 count + per key (u32 len + bytes).
        // Result (stashed): u32 count + per item u8 present (+ u32 len + bytes),
        // in request order. Mirrors the edge `op_get_many` framing byte-for-byte.
        'data.get_many': (handle: number, keysPtr: number, keysLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (keysLen > MAX_VALUE) throw new Error('data: keys blob too large');
            const blob = readCopy(ref, keysPtr, keysLen);
            let off = 0;
            const count = blob.readUInt32LE(off);
            off += 4;
            if (count > 1024) return PRODUCT_ERR; // anti-OOM cap, mirrors the edge
            const header = Buffer.alloc(4);
            header.writeUInt32LE(count, 0);
            const parts: Buffer[] = [header];
            for (let i = 0; i < count; i++) {
                const len = blob.readUInt32LE(off);
                off += 4;
                const key = blob.subarray(off, off + len);
                off += len;
                const v = STORE.get(storeKey(coll, key));
                if (v === undefined) {
                    parts.push(Buffer.from([0]));
                } else {
                    const h = Buffer.alloc(5);
                    h.writeUInt8(1, 0);
                    h.writeUInt32LE(v.length, 1);
                    parts.push(h, v);
                }
            }
            db.lastResult = Buffer.concat(parts);
            return db.lastResult.length;
        },

        'data.exists': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            return STORE.has(storeKey(coll, readCopy(ref, keyPtr, keyLen))) ? 1 : 0;
        },

        'data.create': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (keyLen > MAX_KEY || valLen > MAX_VALUE)
                throw new Error('data: key/value too large');
            const sk = storeKey(coll, readCopy(ref, keyPtr, keyLen));
            if (STORE.has(sk)) return PRODUCT_ERR; // AlreadyExists
            STORE.set(sk, readCopy(ref, valPtr, valLen));
            return 0;
        },

        'data.patch': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            patchPtr: number,
            patchLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (keyLen > MAX_KEY || patchLen > MAX_VALUE)
                throw new Error('data: key/patch too large');
            const sk = storeKey(coll, readCopy(ref, keyPtr, keyLen));
            if (!STORE.has(sk)) return PRODUCT_ERR; // NotFound
            const v = readCopy(ref, patchPtr, patchLen);
            STORE.set(sk, v);
            db.lastResult = v; // patch returns the stored record
            return v.length;
        },

        'data.delete': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            STORE.delete(storeKey(coll, readCopy(ref, keyPtr, keyLen)));
            return 0;
        },

        // Atomic fetch-and-delete (consume-once); deletes only on a real read.
        'data.get_delete': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const sk = storeKey(coll, readCopy(ref, keyPtr, keyLen));
            const v = STORE.get(sk);
            if (v === undefined) return ABSENT;
            STORE.delete(sk);
            db.lastResult = v;
            return v.length;
        },

        // --- unique family (lookup / claim / release) ---

        'data.unique_lookup': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const v = STORE.get(storeKey(coll, readCopy(ref, keyPtr, keyLen)));
            if (v === undefined) return ABSENT;
            db.lastResult = v;
            return v.length;
        },

        // Tag: 0 Claimed, 1 AlreadyClaimed (owner stashed), 2 AlreadyOwnedByCaller.
        'data.unique_claim': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (keyLen > MAX_KEY || valLen > MAX_VALUE)
                throw new Error('data: key/value too large');
            const sk = storeKey(coll, readCopy(ref, keyPtr, keyLen));
            const owner = readCopy(ref, valPtr, valLen);
            const existing = STORE.get(sk);
            if (existing === undefined) {
                STORE.set(sk, owner);
                return 0; // Claimed
            }
            if (existing.equals(owner)) return 2; // AlreadyOwnedByCaller
            db.lastResult = existing;
            return 1; // AlreadyClaimed (current owner stashed)
        },

        'data.unique_release': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const sk = storeKey(coll, readCopy(ref, keyPtr, keyLen));
            const existing = STORE.get(sk);
            if (existing === undefined) return 0; // idempotent
            if (!existing.equals(readCopy(ref, valPtr, valLen))) return PRODUCT_ERR; // not the owner
            STORE.delete(sk);
            return 0;
        },

        // --- membership family (contains / add / remove / list) ---

        'data.membership_contains': (
            handle: number,
            setPtr: number,
            setLen: number,
            memberPtr: number,
            memberLen: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const set = MEMBERS.get(storeKey(coll, readCopy(ref, setPtr, setLen)));
            if (set === undefined) return 0;
            return set.has(readCopy(ref, memberPtr, memberLen).toString('latin1')) ? 1 : 0;
        },

        'data.membership_add': (
            handle: number,
            setPtr: number,
            setLen: number,
            memberPtr: number,
            memberLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (setLen > MAX_KEY || memberLen > MAX_VALUE)
                throw new Error('data: set/member too large');
            const sk = storeKey(coll, readCopy(ref, setPtr, setLen));
            const member = readCopy(ref, memberPtr, memberLen);
            let set = MEMBERS.get(sk);
            if (set === undefined) {
                set = new Map();
                MEMBERS.set(sk, set);
            }
            set.set(member.toString('latin1'), member);
            return 0;
        },

        'data.membership_remove': (
            handle: number,
            setPtr: number,
            setLen: number,
            memberPtr: number,
            memberLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const set = MEMBERS.get(storeKey(coll, readCopy(ref, setPtr, setLen)));
            if (set !== undefined)
                set.delete(readCopy(ref, memberPtr, memberLen).toString('latin1'));
            return 0;
        },

        // Frame the members (sorted by bytes, matching the edge BTreeMap) as
        // `u32 count` + per member `u32 len + bytes`; stash + return the length.
        'data.membership_list': (
            handle: number,
            setPtr: number,
            setLen: number,
            limit: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const set = MEMBERS.get(storeKey(coll, readCopy(ref, setPtr, setLen)));
            const n = Math.max(0, Math.min(limit, 0xffff));
            const members =
                set === undefined ? [] : Array.from(set.values()).sort(Buffer.compare).slice(0, n);
            const header = Buffer.alloc(4);
            header.writeUInt32LE(members.length, 0);
            const parts: Buffer[] = [header];
            for (const m of members) {
                const h = Buffer.alloc(4);
                h.writeUInt32LE(m.length, 0);
                parts.push(h, m);
            }
            db.lastResult = Buffer.concat(parts);
            return db.lastResult.length;
        },

        // --- view family (get / publish) ---

        'data.view_get': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const v = VIEWS.get(storeKey(coll, readCopy(ref, keyPtr, keyLen)));
            if (v === undefined) return ABSENT;
            db.lastResult = v;
            return v.length;
        },

        // Publish overwrites (the host assigns the version; dev keeps the latest).
        'data.view_publish': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/view too large');
            VIEWS.set(storeKey(coll, readCopy(ref, keyPtr, keyLen)), readCopy(ref, valPtr, valLen));
            return 0;
        },

        // --- counter family (get / add) ---

        // Stash the i64 sum as 8 LE bytes; the guest pulls + loads it. A counter
        // with no deltas reads as 0 (never absent).
        'data.counter_get': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const sum = COUNTERS.get(storeKey(coll, readCopy(ref, keyPtr, keyLen))) ?? 0n;
            const out = Buffer.alloc(8);
            out.writeBigInt64LE(sum);
            db.lastResult = out;
            return out.length;
        },

        // `delta` is the wasm i64 (a BigInt across the boundary); `BigInt()`
        // normalizes the test's plain-number form too. Saturates like the edge.
        'data.counter_add': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            delta: number | bigint,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const sk = storeKey(coll, readCopy(ref, keyPtr, keyLen));
            COUNTERS.set(sk, satI64((COUNTERS.get(sk) ?? 0n) + BigInt(delta)));
            return 0;
        },

        // --- events family (append / latest) ---

        'data.append': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            evPtr: number,
            evLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (keyLen > MAX_KEY || evLen > MAX_VALUE) throw new Error('data: key/event too large');
            const sk = storeKey(coll, readCopy(ref, keyPtr, keyLen));
            const log = EVENTS.get(sk);
            const ev = readCopy(ref, evPtr, evLen);
            if (log === undefined) EVENTS.set(sk, [ev]);
            else log.push(ev);
            return 0;
        },

        // Frame the newest-`limit` events as `u32 count` then per event a
        // length-prefixed blob (`u32 len + bytes`), newest first; stash + return
        // the blob length. Matches the edge `op_latest` / `toildb::Writer` framing.
        'data.latest': (handle: number, keyPtr: number, keyLen: number, limit: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const log = EVENTS.get(storeKey(coll, readCopy(ref, keyPtr, keyLen))) ?? [];
            const n = Math.max(0, Math.min(limit, 0xffff));
            const newest = log.slice(Math.max(0, log.length - n)).reverse();
            let size = 4;
            for (const ev of newest) size += 4 + ev.length;
            const out = Buffer.alloc(size);
            let off = out.writeUInt32LE(newest.length, 0);
            for (const ev of newest) {
                off = out.writeUInt32LE(ev.length, off);
                off += ev.copy(out, off);
            }
            db.lastResult = out;
            return out.length;
        },

        // Drain the last stashed variable-length result into the caller buffer.
        'data.take_result': (outPtr: number, outCap: number): number => {
            const v = db.lastResult;
            if (v === null) return 0;
            if (v.length > outCap) return TOO_SMALL; // keep the stash for retry
            const m = mem(ref);
            if (outPtr < 0 || outPtr + v.length > m.length)
                throw new Error('data: take_result out of bounds');
            v.copy(m, outPtr);
            db.lastResult = null;
            return v.length;
        },
    };
}

/** Test-only: clear the stores between unit tests. */
export function __resetDbForTests(): void {
    STORE.clear();
    VIEWS.clear();
    MEMBERS.clear();
    COUNTERS.clear();
    EVENTS.clear();
}

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

import fs from 'node:fs';
import path from 'node:path';

import { parseCatalog } from './dbcatalog.js';
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
/** append_once dedup: `"collection\0key"` -> set of eventIds already appended. */
const EVENT_DEDUP = new Map<string, Set<string>>();
/** Capacity family: `"collection\0key"` -> an escrow ledger (ceiling + reservations). */
const CAPACITY = new Map<string, CapLedger>();

// ---- schema versions: the dev equivalent of the edge binding the row's
// schema_version. Writes STAMP the value type's CURRENT version (from the loaded
// wasm's catalog); reads SURFACE the stamp. When a @data type evolves and the wasm
// is rebuilt, the catalog version changes but data on disk keeps its old stamp, so
// a read reports the old version and the guest's woven decoder runs the @migrate.

/** `"collection\0key"` -> the schema_version the record/view/unique-owner was last
 *  written under (single-value families; the edge stores it per StoredValue). */
const VERSIONS = new Map<string, number>();
/** Per-event schema_version, parallel to `EVENTS[sk]` (append order). */
const EVENT_VERSIONS = new Map<string, number[]>();
/** Per-member schema_version: `sk` -> (memberLatin1 -> version), parallel to `MEMBERS`. */
const MEMBER_VERSIONS = new Map<string, Map<string, number>>();
/** `"<Db>/<collection>"` -> the CURRENT schema_version, from the loaded wasm catalog. */
let CATALOG = new Map<string, number>();

/** (Re)load the collection -> current-schema_version map from a server wasm. The
 *  module loader calls this on every (re)compile so writes stamp the live version. */
export function setDbCatalog(wasm: Buffer): void {
    CATALOG = parseCatalog(wasm);
}

function stampVersion(coll: string, sk: string): void {
    VERSIONS.set(sk, CATALOG.get(coll) ?? 0);
}

// ---- on-disk persistence: dev data + its versions survive restarts, so a
// developer can write rows, evolve a @data type, restart, and watch the @migrate
// run. Delete the file to reset the dev database. JSON with base64 buffers.

interface DbSnapshot {
    store: Record<string, { v: string; sv: number }>; // records + unique owners (+ schema_version)
    views: Record<string, { v: string; sv: number }>;
    members: Record<string, Record<string, { v: string; sv: number }>>;
    counters: Record<string, string>;
    events: Record<string, { v: string; sv: number }[]>;
    eventDedup: Record<string, string[]>;
    capacity: Record<
        string,
        {
            total: string;
            nextId: string;
            reservations: [string, { amount: string; expiresMs: number; confirmed: boolean }][];
        }
    >;
}

let persistPath: string | null = null;

/** Point the dev DB at an on-disk file and load any existing snapshot. Call once at
 *  dev-server startup. Deleting the file (or the whole `.toil/` dir) resets dev data. */
export function configureDbPersistence(filePath: string): void {
    persistPath = filePath;
    loadDb();
}

/** Write the current store to disk (no-op if persistence is not configured). The
 *  module loader calls this after each dispatch so a crash never loses a write. */
export function persistDb(): void {
    if (persistPath === null) return;
    const snap: DbSnapshot = {
        store: {},
        views: {},
        members: {},
        counters: {},
        events: {},
        eventDedup: {},
        capacity: {},
    };
    for (const [k, v] of STORE) snap.store[k] = { v: v.toString('base64'), sv: VERSIONS.get(k) ?? 0 };
    for (const [k, v] of VIEWS) snap.views[k] = { v: v.toString('base64'), sv: VERSIONS.get(k) ?? 0 };
    for (const [k, m] of MEMBERS) {
        const o: Record<string, { v: string; sv: number }> = {};
        const mv = MEMBER_VERSIONS.get(k);
        for (const [mk, mvb] of m) o[mk] = { v: mvb.toString('base64'), sv: mv?.get(mk) ?? 0 };
        snap.members[k] = o;
    }
    for (const [k, v] of COUNTERS) snap.counters[k] = v.toString();
    for (const [k, log] of EVENTS) {
        const ver = EVENT_VERSIONS.get(k) ?? [];
        snap.events[k] = log.map((b, i) => ({ v: b.toString('base64'), sv: ver[i] ?? 0 }));
    }
    for (const [k, s] of EVENT_DEDUP) snap.eventDedup[k] = [...s];
    for (const [k, l] of CAPACITY)
        snap.capacity[k] = {
            total: l.total.toString(),
            nextId: l.nextId.toString(),
            reservations: [...l.reservations].map(([id, r]) => [
                id.toString(),
                { amount: r.amount.toString(), expiresMs: r.expiresMs, confirmed: r.confirmed },
            ]),
        };
    try {
        fs.mkdirSync(path.dirname(persistPath), { recursive: true });
        fs.writeFileSync(persistPath, JSON.stringify(snap));
    } catch {
        // dev-only best effort; a write failure must never crash a request.
    }
}

function loadDb(): void {
    if (persistPath === null) return;
    let snap: DbSnapshot;
    try {
        snap = JSON.parse(fs.readFileSync(persistPath, 'utf8')) as DbSnapshot;
    } catch {
        return; // no snapshot yet (or unreadable) - start empty
    }
    clearDb();
    for (const [k, e] of Object.entries(snap.store ?? {})) {
        STORE.set(k, Buffer.from(e.v, 'base64'));
        VERSIONS.set(k, e.sv);
    }
    for (const [k, e] of Object.entries(snap.views ?? {})) {
        VIEWS.set(k, Buffer.from(e.v, 'base64'));
        VERSIONS.set(k, e.sv);
    }
    for (const [k, m] of Object.entries(snap.members ?? {})) {
        const map = new Map<string, Buffer>();
        const ver = new Map<string, number>();
        for (const [mk, e] of Object.entries(m)) {
            map.set(mk, Buffer.from(e.v, 'base64'));
            ver.set(mk, e.sv);
        }
        MEMBERS.set(k, map);
        MEMBER_VERSIONS.set(k, ver);
    }
    for (const [k, v] of Object.entries(snap.counters ?? {})) COUNTERS.set(k, BigInt(v));
    for (const [k, log] of Object.entries(snap.events ?? {})) {
        EVENTS.set(
            k,
            log.map((e) => Buffer.from(e.v, 'base64')),
        );
        EVENT_VERSIONS.set(
            k,
            log.map((e) => e.sv),
        );
    }
    for (const [k, ids] of Object.entries(snap.eventDedup ?? {})) EVENT_DEDUP.set(k, new Set(ids));
    for (const [k, l] of Object.entries(snap.capacity ?? {})) {
        const res = new Map<bigint, Reservation>();
        for (const [id, r] of l.reservations)
            res.set(BigInt(id), { amount: BigInt(r.amount), expiresMs: r.expiresMs, confirmed: r.confirmed });
        CAPACITY.set(k, { total: BigInt(l.total), nextId: BigInt(l.nextId), reservations: res });
    }
}

function clearDb(): void {
    STORE.clear();
    VERSIONS.clear();
    VIEWS.clear();
    MEMBERS.clear();
    MEMBER_VERSIONS.clear();
    COUNTERS.clear();
    EVENTS.clear();
    EVENT_VERSIONS.clear();
    EVENT_DEDUP.clear();
    CAPACITY.clear();
}

/** A finite-resource escrow: a ceiling + a set of reservations, each held (in
 *  flight, TTL'd) or confirmed (a permanent consume). Both count against available;
 *  a confirmed reservation never expires. Mirrors `toildb::capacity::Escrow`. */
interface Reservation {
    amount: bigint;
    expiresMs: number;
    confirmed: boolean;
}
interface CapLedger {
    total: bigint;
    reservations: Map<bigint, Reservation>;
    nextId: bigint;
}

/** Edge caps (toildb::capacity::escrow): bound the reservation count + the hold TTL. */
const MAX_RESERVATIONS = 4096;
const MAX_RESERVATION_TTL_MS = 86_400_000; // 24h

function capLedger(sk: string): CapLedger {
    let l = CAPACITY.get(sk);
    if (l === undefined) {
        l = { total: 0n, reservations: new Map(), nextId: 1n };
        CAPACITY.set(sk, l);
    }
    return l;
}

/** Drop UN-confirmed reservations whose TTL elapsed (a confirmed sale never expires). */
function capPrune(l: CapLedger, nowMs: number): void {
    for (const [id, r] of l.reservations) if (!r.confirmed && r.expiresMs <= nowMs) l.reservations.delete(id);
}

/** Units reserved against the ceiling: held (un-expired) + confirmed (call capPrune first). */
function capReserved(l: CapLedger): bigint {
    let sum = 0n;
    for (const r of l.reservations.values()) sum += r.amount;
    return sum;
}

const MAX_NAME = 512;
const MAX_KEY = 4096;
const MAX_VALUE = 256 * 1024;

// i64 saturation bounds (the edge `MemEngine`/`ScyllaEngine` counters are i64).
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
function satI64(v: bigint): bigint {
    return v < I64_MIN ? I64_MIN : v > I64_MAX ? I64_MAX : v;
}

// Return codes, mirroring the edge ABI (`toildb::observe::diagnostics`): a typed
// error is `-(1000 + TDLnnn)`; a plain absence is ABSENT (-2), not a typed error.
const ABSENT = -2; // NotFound / absent
const TOO_SMALL = -1;
const INVALID_HANDLE = -1001; // TDL001
const ALREADY_EXISTS = -1003; // TDL003 (create on an existing key)
const CONFLICT = -1004; // TDL004 (e.g. unique release by a non-owner)
const CODEC_ERR = -1006; // TDL006 (e.g. a non-positive reserve amount)
const TOO_MANY_KEYS = -1020; // TDL020 (get_many over the per-call cap)

/** Per-request data state: resolved handles + the last variable-length result +
 *  the schema_version of that result's row (surfaced via result_schema_version). */
export interface DbDevState {
    handles: string[];
    lastResult: Buffer | null;
    lastResultVersion: number;
}

export function freshDbState(): DbDevState {
    return { handles: [], lastResult: null, lastResultVersion: -1 };
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

/** Read + length-cap a KEY. The edge traps a key over MAX_KEY on EVERY op (via
 *  `bound` in prepare_key); enforce it uniformly here so a dev read of an over-cap
 *  key fails the same way instead of silently succeeding. */
function readKey(ref: MemoryRef, ptr: number, len: number): Buffer {
    if (len > MAX_KEY) throw new Error('data: key too long');
    return readCopy(ref, ptr, len);
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
): Record<string, (...args: number[]) => number | bigint> {
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            const v = STORE.get(sk);
            if (v === undefined) return ABSENT;
            db.lastResult = v;
            db.lastResultVersion = VERSIONS.get(sk) ?? 0; // surface the row's stored version
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
            if (count > 1024) return TOO_MANY_KEYS; // anti-OOM cap, mirrors the edge
            const header = Buffer.alloc(4);
            header.writeUInt32LE(count, 0);
            const parts: Buffer[] = [header];
            for (let i = 0; i < count; i++) {
                const len = blob.readUInt32LE(off);
                off += 4;
                const key = blob.subarray(off, off + len);
                off += len;
                const sk = storeKey(coll, key);
                const v = STORE.get(sk);
                if (v === undefined) {
                    parts.push(Buffer.from([0]));
                } else {
                    // present(1) + the row's stored schema_version (per-item @migrate
                    // dispatch) + len(4) + bytes. Mirrors the edge framing.
                    const h = Buffer.alloc(9);
                    h.writeUInt8(1, 0);
                    h.writeUInt32LE(VERSIONS.get(sk) ?? 0, 1);
                    h.writeUInt32LE(v.length, 5);
                    parts.push(h, v);
                }
            }
            db.lastResult = Buffer.concat(parts);
            return db.lastResult.length;
        },

        'data.exists': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            return STORE.has(storeKey(coll, readKey(ref, keyPtr, keyLen))) ? 1 : 0;
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            if (STORE.has(sk)) return ALREADY_EXISTS;
            STORE.set(sk, readCopy(ref, valPtr, valLen));
            stampVersion(coll, sk); // stamp the value type's current schema version
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            if (!STORE.has(sk)) return ABSENT; // NotFound -> ABSENT on the edge
            const v = readCopy(ref, patchPtr, patchLen);
            STORE.set(sk, v);
            stampVersion(coll, sk); // a patch rewrites the row at the current version
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            STORE.delete(sk);
            VERSIONS.delete(sk);
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            const v = STORE.get(sk);
            if (v === undefined) return ABSENT;
            db.lastResultVersion = VERSIONS.get(sk) ?? 0; // surface before consuming
            STORE.delete(sk);
            VERSIONS.delete(sk);
            db.lastResult = v;
            return v.length;
        },

        // --- unique family (lookup / claim / release) ---

        'data.unique_lookup': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            const v = STORE.get(sk);
            if (v === undefined) return ABSENT;
            db.lastResult = v;
            db.lastResultVersion = VERSIONS.get(sk) ?? 0;
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            const owner = readCopy(ref, valPtr, valLen);
            const existing = STORE.get(sk);
            if (existing === undefined) {
                STORE.set(sk, owner);
                stampVersion(coll, sk);
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            const existing = STORE.get(sk);
            if (existing === undefined) return 0; // idempotent
            if (!existing.equals(readCopy(ref, valPtr, valLen))) return CONFLICT; // not the owner
            STORE.delete(sk);
            VERSIONS.delete(sk);
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
            const set = MEMBERS.get(storeKey(coll, readKey(ref, setPtr, setLen)));
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
            const sk = storeKey(coll, readKey(ref, setPtr, setLen));
            const member = readCopy(ref, memberPtr, memberLen);
            let set = MEMBERS.get(sk);
            if (set === undefined) {
                set = new Map();
                MEMBERS.set(sk, set);
            }
            const ml = member.toString('latin1');
            set.set(ml, member);
            let mv = MEMBER_VERSIONS.get(sk);
            if (mv === undefined) {
                mv = new Map();
                MEMBER_VERSIONS.set(sk, mv);
            }
            mv.set(ml, CATALOG.get(coll) ?? 0);
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
            const sk = storeKey(coll, readKey(ref, setPtr, setLen));
            const ml = readCopy(ref, memberPtr, memberLen).toString('latin1');
            MEMBERS.get(sk)?.delete(ml);
            MEMBER_VERSIONS.get(sk)?.delete(ml);
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
            const sk = storeKey(coll, readKey(ref, setPtr, setLen));
            const set = MEMBERS.get(sk);
            const mv = MEMBER_VERSIONS.get(sk);
            const n = Math.max(0, Math.min(limit, 0xffff));
            const members =
                set === undefined ? [] : Array.from(set.values()).sort(Buffer.compare).slice(0, n);
            const header = Buffer.alloc(4);
            header.writeUInt32LE(members.length, 0);
            const parts: Buffer[] = [header];
            for (const m of members) {
                const h = Buffer.alloc(8);
                h.writeUInt32LE(mv?.get(m.toString('latin1')) ?? 0, 0); // per-member stored version
                h.writeUInt32LE(m.length, 4);
                parts.push(h, m);
            }
            db.lastResult = Buffer.concat(parts);
            return db.lastResult.length;
        },

        // --- view family (get / publish) ---

        'data.view_get': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            const v = VIEWS.get(sk);
            if (v === undefined) return ABSENT;
            db.lastResult = v;
            db.lastResultVersion = VERSIONS.get(sk) ?? 0;
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            VIEWS.set(sk, readCopy(ref, valPtr, valLen));
            stampVersion(coll, sk);
            return 0;
        },

        // --- counter family (get / add) ---

        // Stash the i64 sum as 8 LE bytes; the guest pulls + loads it. A counter
        // with no deltas reads as 0 (never absent).
        'data.counter_get': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const sum = COUNTERS.get(storeKey(coll, readKey(ref, keyPtr, keyLen))) ?? 0n;
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
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
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            const log = EVENTS.get(sk);
            const ev = readCopy(ref, evPtr, evLen);
            const sv = CATALOG.get(coll) ?? 0;
            if (log === undefined) {
                EVENTS.set(sk, [ev]);
                EVENT_VERSIONS.set(sk, [sv]);
            } else {
                log.push(ev);
                (EVENT_VERSIONS.get(sk) ?? EVENT_VERSIONS.set(sk, []).get(sk)!).push(sv);
            }
            return 0;
        },

        // Idempotent append: dedup on eventId. 1 appended, 0 duplicate. Mirrors the
        // edge's (key, event_id) dedup marker (just an in-memory set in dev).
        'data.append_once': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            evidPtr: number,
            evidLen: number,
            evPtr: number,
            evLen: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (keyLen > MAX_KEY || evLen > MAX_VALUE) throw new Error('data: key/event too large');
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            const evid = readCopy(ref, evidPtr, evidLen).toString('latin1');
            let seen = EVENT_DEDUP.get(sk);
            if (seen === undefined) {
                seen = new Set();
                EVENT_DEDUP.set(sk, seen);
            }
            if (seen.has(evid)) return 0; // already appended under this id
            const ev = readCopy(ref, evPtr, evLen);
            const sv = CATALOG.get(coll) ?? 0;
            const log = EVENTS.get(sk);
            if (log === undefined) {
                EVENTS.set(sk, [ev]);
                EVENT_VERSIONS.set(sk, [sv]);
            } else {
                log.push(ev);
                (EVENT_VERSIONS.get(sk) ?? EVENT_VERSIONS.set(sk, []).get(sk)!).push(sv);
            }
            seen.add(evid);
            return 1;
        },

        // Version-checked replace of an EXISTING record's value. Returns 0 on apply,
        // ABSENT (-2) if the record is absent. A single dev process has no concurrent
        // writer, so the optimistic-concurrency check always succeeds here.
        'data.enqueue': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/value too large');
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            if (!STORE.has(sk)) return ABSENT; // enqueue replaces an existing record
            STORE.set(sk, readCopy(ref, valPtr, valLen));
            stampVersion(coll, sk);
            return 0;
        },

        // Frame the newest-`limit` events as `u32 count` then per event a
        // length-prefixed blob (`u32 len + bytes`), newest first; stash + return
        // the blob length. Matches the edge `op_latest` / `toildb::Writer` framing.
        'data.latest': (handle: number, keyPtr: number, keyLen: number, limit: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
            const log = EVENTS.get(sk) ?? [];
            const vers = EVENT_VERSIONS.get(sk) ?? [];
            const n = Math.max(0, Math.min(limit, 0xffff));
            const start = Math.max(0, log.length - n);
            const newest = log.slice(start).reverse();
            const newestVers = vers.slice(start).reverse();
            let size = 4;
            for (const ev of newest) size += 8 + ev.length; // version + len + bytes
            const out = Buffer.alloc(size);
            let off = out.writeUInt32LE(newest.length, 0);
            for (let i = 0; i < newest.length; i++) {
                off = out.writeUInt32LE(newestVers[i] ?? 0, off); // per-event stored version
                off = out.writeUInt32LE(newest[i].length, off);
                off += newest[i].copy(out, off);
            }
            db.lastResult = out;
            return out.length;
        },

        // --- capacity family (escrow: set_total / available / reserve / confirm / cancel) ---

        // Set the ceiling (restock / reduce). Job/derive only (kind-gated upstream).
        // A ceiling is never negative.
        'data.capacity_set_total': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            total: number | bigint,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const l = capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
            const t = BigInt(total);
            l.total = satI64(t < 0n ? 0n : t);
            return 0;
        },

        // Stash the i64 available (total - reserved [held + confirmed], floored at 0).
        'data.capacity_available': (handle: number, keyPtr: number, keyLen: number): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const l = capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
            capPrune(l, Date.now());
            const avail = l.total - capReserved(l);
            const out = Buffer.alloc(8);
            out.writeBigInt64LE(avail < 0n ? 0n : avail);
            db.lastResult = out;
            return out.length;
        },

        // Hold `amount` for `ttlMs`: stash the u64 reservation id (8 bytes) on
        // success. A non-positive amount is a typed error (CODEC_ERR), matching the
        // edge's BadAmount; insufficient available OR too many live reservations is
        // ABSENT (-2) (the guest maps that to reservation 0 = no oversell). The TTL
        // is clamped to the edge's 24h ceiling. `now` is the HOST clock.
        'data.capacity_reserve': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            amount: number | bigint,
            ttlMs: number | bigint,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const want = BigInt(amount);
            if (want <= 0n) return CODEC_ERR; // BadAmount (edge: -1006)
            const l = capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
            const now = Date.now();
            capPrune(l, now);
            if (l.total - capReserved(l) < want || l.reservations.size >= MAX_RESERVATIONS)
                return ABSENT; // never oversell; bound the reservation count
            const ttl = Math.min(Math.max(0, Number(ttlMs)), MAX_RESERVATION_TTL_MS);
            const id = l.nextId++;
            l.reservations.set(id, { amount: want, expiresMs: now + ttl, confirmed: false });
            const out = Buffer.alloc(8);
            out.writeBigUInt64LE(id);
            db.lastResult = out;
            return out.length;
        },

        // Finalize a reservation into a permanent consume. IDEMPOTENT: the
        // reservation is flagged confirmed (and kept), so a retry of a settled id
        // still returns 1; 0 only when the id is unknown / expired-and-pruned.
        'data.capacity_confirm': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            reservationId: number | bigint,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const l = capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
            capPrune(l, Date.now());
            const r = l.reservations.get(BigInt(reservationId));
            if (r === undefined) return 0;
            r.confirmed = true;
            return 1;
        },

        // Release a HELD reservation back to available. A confirmed sale cannot be
        // cancelled (returns 0), nor an unknown id.
        'data.capacity_cancel': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            reservationId: number | bigint,
            _idemPtr: number,
        ): number => {
            const coll = collOf(db, handle);
            if (coll === null) return INVALID_HANDLE;
            const l = capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
            capPrune(l, Date.now());
            const id = BigInt(reservationId);
            const r = l.reservations.get(id);
            if (r === undefined || r.confirmed) return 0;
            l.reservations.delete(id);
            return 1;
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

        // `data.result_schema_version() -> i64`: the schema_version the last
        // value-returning read's row was written under, so the guest's woven decoder
        // runs the right @migrate. With on-disk persistence + catalog version
        // stamping, dev DOES surface historical versions: a row written under an old
        // @data layout reports that old version after the type evolves, so the dev
        // server exercises real cross-version decode. -1 means the last op returned
        // no value. An i64 result returns a BigInt in Node's WASM ABI.
        'data.result_schema_version': (): bigint => BigInt(db.lastResultVersion),

        // `data.write_allowed() -> i32`: 1 if the current call may write. Used by the
        // rewrite-on-read convergence after a lazy migration to persist the converged
        // row. The dev store permits writes, so return 1.
        'data.write_allowed': (): number => 1,
    };
}

/** Test-only: clear the stores + catalog + persistence between unit tests. */
export function __resetDbForTests(): void {
    clearDb();
    CATALOG = new Map();
    persistPath = null;
}

/** Test-only: seed the catalog (collection -> current schema_version) directly. */
export function __setDbCatalogForTests(entries: Record<string, number>): void {
    CATALOG = new Map(Object.entries(entries));
}

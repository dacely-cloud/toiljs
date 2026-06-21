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
 * production path. All seven families (record/view/unique/events/membership/
 * counter/capacity) live on the {@link DevDatabase} class; one process shares a
 * single instance ({@link devDb}), since the dev store is one per process.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DataReader, DataWriter } from 'toiljs/io';
import type { MemoryRef } from '../runtime/host.js';
import { parseCatalog } from './catalog.js';
import {
    ABSENT,
    ALREADY_EXISTS,
    type CapLedger,
    CODEC_ERR,
    CONFLICT,
    type DbDevState,
    type DbSnapshot,
    INVALID_HANDLE,
    MAX_KEY,
    MAX_NAME,
    MAX_RESERVATION_TTL_MS,
    MAX_RESERVATIONS,
    MAX_VALUE,
    type Reservation,
    satI64,
    TOO_MANY_KEYS,
    TOO_SMALL,
} from './types.js';

// ---- schema versions: the dev equivalent of the edge binding the row's
// schema_version. Writes STAMP the value type's CURRENT version (from the loaded
// wasm's catalog); reads SURFACE the stamp. When a @data type evolves and the wasm
// is rebuilt, the catalog version changes but data on disk keeps its old stamp, so
// a read reports the old version and the guest's woven decoder runs the @migrate.

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

/**
 * The single-process dev data store: the seven ToilDB families, their per-row
 * schema_versions, the loaded wasm's catalog, and optional on-disk persistence.
 * Process-lifetime, shared across dispatches via the module singleton {@link devDb}.
 */
export class DevDatabase {
    /** Process-lifetime store: `"collection\0keyLatin1"` -> value. Shared across dispatches. */
    private readonly store = new Map<string, Buffer>();
    /** View family: `"collection\0key"` -> the latest published view blob. */
    private readonly views = new Map<string, Buffer>();
    /** Membership family: `"collection\0setKey"` -> (memberLatin1 -> member bytes). */
    private readonly members = new Map<string, Map<string, Buffer>>();
    /** Counter family: `"collection\0key"` -> saturating i64 sum of deltas. */
    private readonly counters = new Map<string, bigint>();
    /** Events family: `"collection\0key"` -> append-ordered event blobs (oldest first). */
    private readonly events = new Map<string, Buffer[]>();
    /** append_once dedup: `"collection\0key"` -> set of eventIds already appended. */
    private readonly eventDedup = new Map<string, Set<string>>();
    /** Capacity family: `"collection\0key"` -> an escrow ledger (ceiling + reservations). */
    private readonly capacity = new Map<string, CapLedger>();

    /** `"collection\0key"` -> the schema_version the record/view/unique-owner was last
     *  written under (single-value families; the edge stores it per StoredValue). */
    private readonly versions = new Map<string, number>();
    /** Per-event schema_version, parallel to `events[sk]` (append order). */
    private readonly eventVersions = new Map<string, number[]>();
    /** Per-member schema_version: `sk` -> (memberLatin1 -> version), parallel to `members`. */
    private readonly memberVersions = new Map<string, Map<string, number>>();
    /** `"<Db>/<collection>"` -> the CURRENT schema_version, from the loaded wasm catalog. */
    private catalog = new Map<string, number>();

    // ---- on-disk persistence: dev data + its versions survive restarts, so a
    // developer can write rows, evolve a @data type, restart, and watch the @migrate
    // run. Delete the file to reset the dev database. JSON with base64 buffers.
    private persistPath: string | null = null;

    /** (Re)load the collection -> current-schema_version map from a server wasm. The
     *  module loader calls this on every (re)compile so writes stamp the live version. */
    setCatalog(wasm: Buffer): void {
        this.catalog = parseCatalog(wasm);
    }

    private stampVersion(coll: string, sk: string): void {
        this.versions.set(sk, this.catalog.get(coll) ?? 0); // stamp the value type's current version
    }

    /** Point the dev DB at an on-disk file and load any existing snapshot. Call once at
     *  dev-server startup. Deleting the file (or the whole `.toil/` dir) resets dev data. */
    configurePersistence(filePath: string): void {
        this.persistPath = filePath;
        this.load();
    }

    /** Write the current store to disk (no-op if persistence is not configured). The
     *  module loader calls this after each dispatch so a crash never loses a write. */
    persist(): void {
        if (this.persistPath === null) return;
        const snap: DbSnapshot = {
            store: {},
            views: {},
            members: {},
            counters: {},
            events: {},
            eventDedup: {},
            capacity: {},
        };
        for (const [k, v] of this.store)
            snap.store[k] = { v: v.toString('base64'), sv: this.versions.get(k) ?? 0 };
        for (const [k, v] of this.views)
            snap.views[k] = { v: v.toString('base64'), sv: this.versions.get(k) ?? 0 };
        for (const [k, m] of this.members) {
            const o: Record<string, { v: string; sv: number }> = {};
            const mv = this.memberVersions.get(k);
            for (const [mk, mvb] of m) o[mk] = { v: mvb.toString('base64'), sv: mv?.get(mk) ?? 0 };
            snap.members[k] = o;
        }
        for (const [k, v] of this.counters) snap.counters[k] = v.toString();
        for (const [k, log] of this.events) {
            const ver = this.eventVersions.get(k) ?? [];
            snap.events[k] = log.map((b, i) => ({ v: b.toString('base64'), sv: ver[i] ?? 0 }));
        }
        for (const [k, s] of this.eventDedup) snap.eventDedup[k] = [...s];
        for (const [k, l] of this.capacity)
            snap.capacity[k] = {
                total: l.total.toString(),
                nextId: l.nextId.toString(),
                reservations: [...l.reservations].map(([id, r]) => [
                    id.toString(),
                    { amount: r.amount.toString(), expiresMs: r.expiresMs, confirmed: r.confirmed },
                ]),
            };
        try {
            fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
            // Write to a temp file then rename: atomic on POSIX, so a crash mid-write
            // leaves the previous good snapshot intact instead of a truncated file
            // that would fail to parse and drop the whole dev database on next load.
            const tmp = `${this.persistPath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(snap));
            fs.renameSync(tmp, this.persistPath);
        } catch {
            // dev-only best effort; a write failure must never crash a request.
        }
    }

    private load(): void {
        if (this.persistPath === null) return;
        let snap: DbSnapshot;
        try {
            snap = JSON.parse(fs.readFileSync(this.persistPath, 'utf8')) as DbSnapshot;
        } catch {
            return; // no snapshot yet (or unreadable) - start empty
        }
        this.clear();
        for (const [k, e] of Object.entries(snap.store ?? {})) {
            this.store.set(k, Buffer.from(e.v, 'base64'));
            this.versions.set(k, e.sv);
        }
        for (const [k, e] of Object.entries(snap.views ?? {})) {
            this.views.set(k, Buffer.from(e.v, 'base64'));
            this.versions.set(k, e.sv);
        }
        for (const [k, m] of Object.entries(snap.members ?? {})) {
            const map = new Map<string, Buffer>();
            const ver = new Map<string, number>();
            for (const [mk, e] of Object.entries(m)) {
                map.set(mk, Buffer.from(e.v, 'base64'));
                ver.set(mk, e.sv);
            }
            this.members.set(k, map);
            this.memberVersions.set(k, ver);
        }
        for (const [k, v] of Object.entries(snap.counters ?? {})) this.counters.set(k, BigInt(v));
        for (const [k, log] of Object.entries(snap.events ?? {})) {
            this.events.set(
                k,
                log.map((e) => Buffer.from(e.v, 'base64')),
            );
            this.eventVersions.set(
                k,
                log.map((e) => e.sv),
            );
        }
        for (const [k, ids] of Object.entries(snap.eventDedup ?? {}))
            this.eventDedup.set(k, new Set(ids));
        for (const [k, l] of Object.entries(snap.capacity ?? {})) {
            const res = new Map<bigint, Reservation>();
            for (const [id, r] of l.reservations)
                res.set(BigInt(id), {
                    amount: BigInt(r.amount),
                    expiresMs: r.expiresMs,
                    confirmed: r.confirmed,
                });
            this.capacity.set(k, {
                total: BigInt(l.total),
                nextId: BigInt(l.nextId),
                reservations: res,
            });
        }
    }

    private clear(): void {
        this.store.clear();
        this.versions.clear();
        this.views.clear();
        this.members.clear();
        this.memberVersions.clear();
        this.counters.clear();
        this.eventVersions.clear();
        this.events.clear();
        this.eventDedup.clear();
        this.capacity.clear();
    }

    private capLedger(sk: string): CapLedger {
        let l = this.capacity.get(sk);
        if (l === undefined) {
            l = { total: 0n, reservations: new Map(), nextId: 1n };
            this.capacity.set(sk, l);
        }
        return l;
    }

    /** Drop UN-confirmed reservations whose TTL elapsed (a confirmed sale never expires). */
    private capPrune(l: CapLedger, nowMs: number): void {
        for (const [id, r] of l.reservations)
            if (!r.confirmed && r.expiresMs <= nowMs) l.reservations.delete(id);
    }

    /** Units reserved against the ceiling: held (un-expired) + confirmed (call capPrune first). */
    private capReserved(l: CapLedger): bigint {
        let sum = 0n;
        for (const r of l.reservations.values()) sum += r.amount;
        return sum;
    }

    // --- record family (resolve / get / get_many / exists / create / patch /
    //     delete / get_delete) ---

    resolveCollection(
        ref: MemoryRef,
        db: DbDevState,
        namePtr: number,
        nameLen: number,
        outHandlePtr: number,
    ): number {
        if (nameLen < 0 || nameLen > MAX_NAME) throw new Error('data: collection name too long');
        const name = readCopy(ref, namePtr, nameLen).toString('utf8');
        const handle = db.handles.length;
        db.handles.push(name);
        const m = mem(ref);
        if (outHandlePtr < 0 || outHandlePtr + 4 > m.length)
            throw new Error('data: resolve out-handle out of bounds');
        m.writeUInt32LE(handle, outHandlePtr);
        return 0;
    }

    get(ref: MemoryRef, db: DbDevState, handle: number, keyPtr: number, keyLen: number): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (keyLen > MAX_KEY) throw new Error('data: key too long');
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        const v = this.store.get(sk);
        if (v === undefined) return ABSENT;
        db.lastResult = v;
        db.lastResultVersion = this.versions.get(sk) ?? 0; // surface the row's stored version
        return v.length;
    }

    // Bounded multi-get. Keys blob: u32 count + per key (u32 len + bytes).
    // Result (stashed): u32 count + per item u8 present (+ u32 len + bytes),
    // in request order. Mirrors the edge `op_get_many` framing byte-for-byte.
    getMany(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keysPtr: number,
        keysLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (keysLen > MAX_VALUE) throw new Error('data: keys blob too large');
        // Keys blob: u32 count, then per key a u32-length-prefixed blob. The shared
        // DataReader is bounds-safe (empty past end), so a malformed/truncated blob
        // can't over-read; cap each key at MAX_KEY like the edge's prepare_key.
        const r = new DataReader(readCopy(ref, keysPtr, keysLen));
        const count = r.readU32();
        if (count > 1024) return TOO_MANY_KEYS; // anti-OOM cap, mirrors the edge
        // Result: u32 count, then per item present(u8) + (when present) the row's
        // stored schema_version (u32, per-item @migrate dispatch) + value (u32 len +
        // bytes). Byte-identical to the edge op_get_many framing.
        const w = new DataWriter();
        w.writeU32(count);
        for (let i = 0; i < count; i++) {
            const key = r.readBytes();
            if (key.length > MAX_KEY) throw new Error('data: key too long');
            const sk = storeKey(coll, Buffer.from(key));
            const v = this.store.get(sk);
            if (v === undefined) {
                w.writeU8(0);
            } else {
                w.writeU8(1).writeU32(this.versions.get(sk) ?? 0).writeBytes(v);
            }
        }
        db.lastResult = Buffer.from(w.toBytes());
        return db.lastResult.length;
    }

    exists(ref: MemoryRef, db: DbDevState, handle: number, keyPtr: number, keyLen: number): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        return this.store.has(storeKey(coll, readKey(ref, keyPtr, keyLen))) ? 1 : 0;
    }

    create(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        valPtr: number,
        valLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/value too large');
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        if (this.store.has(sk)) return ALREADY_EXISTS;
        this.store.set(sk, readCopy(ref, valPtr, valLen));
        this.stampVersion(coll, sk); // stamp the value type's current schema version
        return 0;
    }

    patch(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        patchPtr: number,
        patchLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (keyLen > MAX_KEY || patchLen > MAX_VALUE) throw new Error('data: key/patch too large');
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        if (!this.store.has(sk)) return ABSENT; // NotFound -> ABSENT on the edge
        const v = readCopy(ref, patchPtr, patchLen);
        this.store.set(sk, v);
        this.stampVersion(coll, sk); // a patch rewrites the row at the current version
        db.lastResult = v; // patch returns the stored record
        db.lastResultVersion = -1; // the just-written value is current; never migrate it (matches the edge's LenStash None)
        return v.length;
    }

    delete(ref: MemoryRef, db: DbDevState, handle: number, keyPtr: number, keyLen: number): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        this.store.delete(sk);
        this.versions.delete(sk);
        return 0;
    }

    // Atomic fetch-and-delete (consume-once); deletes only on a real read.
    getDelete(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        const v = this.store.get(sk);
        if (v === undefined) return ABSENT;
        db.lastResultVersion = this.versions.get(sk) ?? 0; // surface before consuming
        this.store.delete(sk);
        this.versions.delete(sk);
        db.lastResult = v;
        return v.length;
    }

    // --- unique family (lookup / claim / release) ---

    uniqueLookup(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        const v = this.store.get(sk);
        if (v === undefined) return ABSENT;
        db.lastResult = v;
        db.lastResultVersion = this.versions.get(sk) ?? 0;
        return v.length;
    }

    // Tag: 0 Claimed, 1 AlreadyClaimed (owner stashed), 2 AlreadyOwnedByCaller.
    uniqueClaim(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        valPtr: number,
        valLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/value too large');
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        const owner = readCopy(ref, valPtr, valLen);
        const existing = this.store.get(sk);
        if (existing === undefined) {
            this.store.set(sk, owner);
            this.stampVersion(coll, sk);
            return 0; // Claimed
        }
        if (existing.equals(owner)) return 2; // AlreadyOwnedByCaller
        db.lastResult = existing;
        return 1; // AlreadyClaimed (current owner stashed)
    }

    uniqueRelease(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        valPtr: number,
        valLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        const existing = this.store.get(sk);
        if (existing === undefined) return 0; // idempotent
        if (!existing.equals(readCopy(ref, valPtr, valLen))) return CONFLICT; // not the owner
        this.store.delete(sk);
        this.versions.delete(sk);
        return 0;
    }

    // --- membership family (contains / add / remove / list) ---

    membershipContains(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        setPtr: number,
        setLen: number,
        memberPtr: number,
        memberLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const set = this.members.get(storeKey(coll, readKey(ref, setPtr, setLen)));
        if (set === undefined) return 0;
        return set.has(readCopy(ref, memberPtr, memberLen).toString('latin1')) ? 1 : 0;
    }

    membershipAdd(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        setPtr: number,
        setLen: number,
        memberPtr: number,
        memberLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (setLen > MAX_KEY || memberLen > MAX_VALUE)
            throw new Error('data: set/member too large');
        const sk = storeKey(coll, readKey(ref, setPtr, setLen));
        const member = readCopy(ref, memberPtr, memberLen);
        let set = this.members.get(sk);
        if (set === undefined) {
            set = new Map();
            this.members.set(sk, set);
        }
        const ml = member.toString('latin1');
        set.set(ml, member);
        let mv = this.memberVersions.get(sk);
        if (mv === undefined) {
            mv = new Map();
            this.memberVersions.set(sk, mv);
        }
        mv.set(ml, this.catalog.get(coll) ?? 0);
        return 0;
    }

    membershipRemove(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        setPtr: number,
        setLen: number,
        memberPtr: number,
        memberLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sk = storeKey(coll, readKey(ref, setPtr, setLen));
        const ml = readCopy(ref, memberPtr, memberLen).toString('latin1');
        this.members.get(sk)?.delete(ml);
        this.memberVersions.get(sk)?.delete(ml);
        return 0;
    }

    // Frame the members (sorted by bytes, matching the edge BTreeMap) as
    // `u32 count` + per member `u32 len + bytes`; stash + return the length.
    membershipList(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        setPtr: number,
        setLen: number,
        limit: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sk = storeKey(coll, readKey(ref, setPtr, setLen));
        const set = this.members.get(sk);
        const mv = this.memberVersions.get(sk);
        const n = Math.max(0, Math.min(limit, 0xffff));
        const members =
            set === undefined ? [] : Array.from(set.values()).sort(Buffer.compare).slice(0, n);
        // u32 count, then per member its stored schema_version (u32) + bytes (u32
        // len + bytes). Same framing as the edge op_membership_list.
        const w = new DataWriter();
        w.writeU32(members.length);
        for (const m of members) {
            w.writeU32(mv?.get(m.toString('latin1')) ?? 0).writeBytes(m);
        }
        db.lastResult = Buffer.from(w.toBytes());
        return db.lastResult.length;
    }

    // --- view family (get / publish) ---

    viewGet(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        const v = this.views.get(sk);
        if (v === undefined) return ABSENT;
        db.lastResult = v;
        db.lastResultVersion = this.versions.get(sk) ?? 0;
        return v.length;
    }

    // Publish overwrites (the host assigns the version; dev keeps the latest).
    viewPublish(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        valPtr: number,
        valLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/view too large');
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        this.views.set(sk, readCopy(ref, valPtr, valLen));
        this.stampVersion(coll, sk);
        return 0;
    }

    // --- counter family (get / add) ---

    // Stash the i64 sum as 8 LE bytes; the guest pulls + loads it. A counter
    // with no deltas reads as 0 (never absent).
    counterGet(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sum = this.counters.get(storeKey(coll, readKey(ref, keyPtr, keyLen))) ?? 0n;
        const out = Buffer.alloc(8);
        out.writeBigInt64LE(sum);
        db.lastResult = out;
        return out.length;
    }

    // `delta` is the wasm i64 (a BigInt across the boundary); `BigInt()`
    // normalizes the test's plain-number form too. Saturates like the edge.
    counterAdd(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        delta: number | bigint,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        this.counters.set(sk, satI64((this.counters.get(sk) ?? 0n) + BigInt(delta)));
        return 0;
    }

    // --- events family (append / append_once / enqueue / latest) ---

    append(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        evPtr: number,
        evLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (keyLen > MAX_KEY || evLen > MAX_VALUE) throw new Error('data: key/event too large');
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        const log = this.events.get(sk);
        const ev = readCopy(ref, evPtr, evLen);
        const sv = this.catalog.get(coll) ?? 0;
        if (log === undefined) {
            this.events.set(sk, [ev]);
            this.eventVersions.set(sk, [sv]);
        } else {
            log.push(ev);
            (this.eventVersions.get(sk) ?? this.eventVersions.set(sk, []).get(sk)!).push(sv);
        }
        return 0;
    }

    // Idempotent append: dedup on eventId. 1 appended, 0 duplicate. Mirrors the
    // edge's (key, event_id) dedup marker (just an in-memory set in dev).
    appendOnce(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        evidPtr: number,
        evidLen: number,
        evPtr: number,
        evLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (keyLen > MAX_KEY || evLen > MAX_VALUE) throw new Error('data: key/event too large');
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        const evid = readCopy(ref, evidPtr, evidLen).toString('latin1');
        let seen = this.eventDedup.get(sk);
        if (seen === undefined) {
            seen = new Set();
            this.eventDedup.set(sk, seen);
        }
        if (seen.has(evid)) return 0; // already appended under this id
        const ev = readCopy(ref, evPtr, evLen);
        const sv = this.catalog.get(coll) ?? 0;
        const log = this.events.get(sk);
        if (log === undefined) {
            this.events.set(sk, [ev]);
            this.eventVersions.set(sk, [sv]);
        } else {
            log.push(ev);
            (this.eventVersions.get(sk) ?? this.eventVersions.set(sk, []).get(sk)!).push(sv);
        }
        seen.add(evid);
        return 1;
    }

    // Version-checked replace of an EXISTING record's value. Returns 0 on apply,
    // ABSENT (-2) if the record is absent. A single dev process has no concurrent
    // writer, so the optimistic-concurrency check always succeeds here.
    enqueue(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        valPtr: number,
        valLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/value too large');
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        if (!this.store.has(sk)) return ABSENT; // enqueue replaces an existing record
        this.store.set(sk, readCopy(ref, valPtr, valLen));
        this.stampVersion(coll, sk);
        return 0;
    }

    // Frame the newest-`limit` events as `u32 count` then per event a
    // length-prefixed blob (`u32 len + bytes`), newest first; stash + return
    // the blob length. Matches the edge `op_latest` / `toildb::Writer` framing.
    latest(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        limit: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const sk = storeKey(coll, readKey(ref, keyPtr, keyLen));
        const log = this.events.get(sk) ?? [];
        const vers = this.eventVersions.get(sk) ?? [];
        const n = Math.max(0, Math.min(limit, 0xffff));
        const start = Math.max(0, log.length - n);
        const newest = log.slice(start).reverse();
        const newestVers = vers.slice(start).reverse();
        // u32 count, then per event its stored schema_version (u32) + bytes (u32 len
        // + bytes), newest first. Same framing as the edge op_latest.
        const w = new DataWriter();
        w.writeU32(newest.length);
        for (let i = 0; i < newest.length; i++) {
            w.writeU32(newestVers[i] ?? 0).writeBytes(newest[i]);
        }
        db.lastResult = Buffer.from(w.toBytes());
        return db.lastResult.length;
    }

    // --- capacity family (escrow: set_total / available / reserve / confirm / cancel) ---

    // Set the ceiling (restock / reduce). Job/derive only (kind-gated upstream).
    // A ceiling is never negative.
    capacitySetTotal(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        total: number | bigint,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const l = this.capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
        const t = BigInt(total);
        l.total = satI64(t < 0n ? 0n : t);
        return 0;
    }

    // Stash the i64 available (total - reserved [held + confirmed], floored at 0).
    capacityAvailable(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const l = this.capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
        this.capPrune(l, Date.now());
        const avail = l.total - this.capReserved(l);
        const out = Buffer.alloc(8);
        out.writeBigInt64LE(avail < 0n ? 0n : avail);
        db.lastResult = out;
        return out.length;
    }

    // Hold `amount` for `ttlMs`: stash the u64 reservation id (8 bytes) on
    // success. A non-positive amount is a typed error (CODEC_ERR), matching the
    // edge's BadAmount; insufficient available OR too many live reservations is
    // ABSENT (-2) (the guest maps that to reservation 0 = no oversell). The TTL
    // is clamped to the edge's 24h ceiling. `now` is the HOST clock.
    capacityReserve(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        amount: number | bigint,
        ttlMs: number | bigint,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const want = BigInt(amount);
        if (want <= 0n) return CODEC_ERR; // BadAmount (edge: -1006)
        const l = this.capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
        const now = Date.now();
        this.capPrune(l, now);
        if (l.total - this.capReserved(l) < want || l.reservations.size >= MAX_RESERVATIONS)
            return ABSENT; // never oversell; bound the reservation count
        const ttl = Math.min(Math.max(0, Number(ttlMs)), MAX_RESERVATION_TTL_MS);
        const id = l.nextId++;
        l.reservations.set(id, { amount: want, expiresMs: now + ttl, confirmed: false });
        const out = Buffer.alloc(8);
        out.writeBigUInt64LE(id);
        db.lastResult = out;
        return out.length;
    }

    // Finalize a reservation into a permanent consume. IDEMPOTENT: the
    // reservation is flagged confirmed (and kept), so a retry of a settled id
    // still returns 1; 0 only when the id is unknown / expired-and-pruned.
    capacityConfirm(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        reservationId: number | bigint,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const l = this.capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
        this.capPrune(l, Date.now());
        const r = l.reservations.get(BigInt(reservationId));
        if (r === undefined) return 0;
        r.confirmed = true;
        return 1;
    }

    // Release a HELD reservation back to available. A confirmed sale cannot be
    // cancelled (returns 0), nor an unknown id.
    capacityCancel(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        reservationId: number | bigint,
    ): number {
        const coll = collOf(db, handle);
        if (coll === null) return INVALID_HANDLE;
        const l = this.capLedger(storeKey(coll, readKey(ref, keyPtr, keyLen)));
        this.capPrune(l, Date.now());
        const id = BigInt(reservationId);
        const r = l.reservations.get(id);
        if (r === undefined || r.confirmed) return 0;
        l.reservations.delete(id);
        return 1;
    }

    // --- result pull + per-row metadata ---

    // Drain the last stashed variable-length result into the caller buffer.
    takeResult(ref: MemoryRef, db: DbDevState, outPtr: number, outCap: number): number {
        const v = db.lastResult;
        if (v === null) return 0;
        if (v.length > outCap) return TOO_SMALL; // keep the stash for retry
        const m = mem(ref);
        if (outPtr < 0 || outPtr + v.length > m.length)
            throw new Error('data: take_result out of bounds');
        v.copy(m, outPtr);
        db.lastResult = null;
        return v.length;
    }

    // `data.result_schema_version() -> i64`: the schema_version the last
    // value-returning read's row was written under, so the guest's woven decoder
    // runs the right @migrate. With on-disk persistence + catalog version
    // stamping, dev DOES surface historical versions: a row written under an old
    // @data layout reports that old version after the type evolves, so the dev
    // server exercises real cross-version decode. -1 means the last op returned
    // no value. An i64 result returns a BigInt in Node's WASM ABI.
    resultSchemaVersion(db: DbDevState): bigint {
        return BigInt(db.lastResultVersion);
    }

    // --- test hooks ---

    /** Test-only: clear the stores + catalog + persistence between unit tests. */
    resetForTests(): void {
        this.clear();
        this.catalog = new Map();
        this.persistPath = null;
    }

    /** Test-only: seed the catalog (collection -> current schema_version) directly. */
    setCatalogForTests(entries: Record<string, number>): void {
        this.catalog = new Map(Object.entries(entries));
    }
}

/** The single process-lifetime dev database (one store per dev/self-host process). */
export const devDb = new DevDatabase();

/** (Re)load the collection -> current schema_version map from a server wasm. */
export function setDbCatalog(wasm: Buffer): void {
    devDb.setCatalog(wasm);
}

/** Point the dev DB at an on-disk file and load any existing snapshot. */
export function configureDbPersistence(filePath: string): void {
    devDb.configurePersistence(filePath);
}

/** Write the current store to disk (no-op if persistence is not configured). */
export function persistDb(): void {
    devDb.persist();
}

/**
 * Build the `data.*` host imports for one instance, delegating to the shared
 * {@link devDb}. `db` is the per-request state (handles + result stash); bind a
 * fresh one per dispatch.
 */
export function buildDatabaseImports(
    ref: MemoryRef,
    db: DbDevState,
): Record<string, (...args: number[]) => number | bigint> {
    return {
        'data.resolve_collection': (
            namePtr: number,
            nameLen: number,
            outHandlePtr: number,
        ): number => devDb.resolveCollection(ref, db, namePtr, nameLen, outHandlePtr),

        'data.get': (handle: number, keyPtr: number, keyLen: number): number =>
            devDb.get(ref, db, handle, keyPtr, keyLen),

        'data.get_many': (handle: number, keysPtr: number, keysLen: number): number =>
            devDb.getMany(ref, db, handle, keysPtr, keysLen),

        'data.exists': (handle: number, keyPtr: number, keyLen: number): number =>
            devDb.exists(ref, db, handle, keyPtr, keyLen),

        'data.create': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => devDb.create(ref, db, handle, keyPtr, keyLen, valPtr, valLen),

        'data.patch': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            patchPtr: number,
            patchLen: number,
            _idemPtr: number,
        ): number => devDb.patch(ref, db, handle, keyPtr, keyLen, patchPtr, patchLen),

        'data.delete': (handle: number, keyPtr: number, keyLen: number, _idemPtr: number): number =>
            devDb.delete(ref, db, handle, keyPtr, keyLen),

        'data.get_delete': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            _idemPtr: number,
        ): number => devDb.getDelete(ref, db, handle, keyPtr, keyLen),

        'data.unique_lookup': (handle: number, keyPtr: number, keyLen: number): number =>
            devDb.uniqueLookup(ref, db, handle, keyPtr, keyLen),

        'data.unique_claim': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => devDb.uniqueClaim(ref, db, handle, keyPtr, keyLen, valPtr, valLen),

        'data.unique_release': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => devDb.uniqueRelease(ref, db, handle, keyPtr, keyLen, valPtr, valLen),

        'data.membership_contains': (
            handle: number,
            setPtr: number,
            setLen: number,
            memberPtr: number,
            memberLen: number,
        ): number =>
            devDb.membershipContains(ref, db, handle, setPtr, setLen, memberPtr, memberLen),

        'data.membership_add': (
            handle: number,
            setPtr: number,
            setLen: number,
            memberPtr: number,
            memberLen: number,
            _idemPtr: number,
        ): number => devDb.membershipAdd(ref, db, handle, setPtr, setLen, memberPtr, memberLen),

        'data.membership_remove': (
            handle: number,
            setPtr: number,
            setLen: number,
            memberPtr: number,
            memberLen: number,
            _idemPtr: number,
        ): number => devDb.membershipRemove(ref, db, handle, setPtr, setLen, memberPtr, memberLen),

        'data.membership_list': (
            handle: number,
            setPtr: number,
            setLen: number,
            limit: number,
        ): number => devDb.membershipList(ref, db, handle, setPtr, setLen, limit),

        'data.view_get': (handle: number, keyPtr: number, keyLen: number): number =>
            devDb.viewGet(ref, db, handle, keyPtr, keyLen),

        'data.view_publish': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => devDb.viewPublish(ref, db, handle, keyPtr, keyLen, valPtr, valLen),

        'data.counter_get': (handle: number, keyPtr: number, keyLen: number): number =>
            devDb.counterGet(ref, db, handle, keyPtr, keyLen),

        'data.counter_add': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            delta: number | bigint,
            _idemPtr: number,
        ): number => devDb.counterAdd(ref, db, handle, keyPtr, keyLen, delta),

        'data.append': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            evPtr: number,
            evLen: number,
            _idemPtr: number,
        ): number => devDb.append(ref, db, handle, keyPtr, keyLen, evPtr, evLen),

        'data.append_once': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            evidPtr: number,
            evidLen: number,
            evPtr: number,
            evLen: number,
        ): number =>
            devDb.appendOnce(ref, db, handle, keyPtr, keyLen, evidPtr, evidLen, evPtr, evLen),

        'data.enqueue': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            _idemPtr: number,
        ): number => devDb.enqueue(ref, db, handle, keyPtr, keyLen, valPtr, valLen),

        'data.latest': (handle: number, keyPtr: number, keyLen: number, limit: number): number =>
            devDb.latest(ref, db, handle, keyPtr, keyLen, limit),

        'data.capacity_set_total': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            total: number | bigint,
            _idemPtr: number,
        ): number => devDb.capacitySetTotal(ref, db, handle, keyPtr, keyLen, total),

        'data.capacity_available': (handle: number, keyPtr: number, keyLen: number): number =>
            devDb.capacityAvailable(ref, db, handle, keyPtr, keyLen),

        'data.capacity_reserve': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            amount: number | bigint,
            ttlMs: number | bigint,
            _idemPtr: number,
        ): number => devDb.capacityReserve(ref, db, handle, keyPtr, keyLen, amount, ttlMs),

        'data.capacity_confirm': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            reservationId: number | bigint,
            _idemPtr: number,
        ): number => devDb.capacityConfirm(ref, db, handle, keyPtr, keyLen, reservationId),

        'data.capacity_cancel': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            reservationId: number | bigint,
            _idemPtr: number,
        ): number => devDb.capacityCancel(ref, db, handle, keyPtr, keyLen, reservationId),

        'data.take_result': (outPtr: number, outCap: number): number =>
            devDb.takeResult(ref, db, outPtr, outCap),

        'data.result_schema_version': (): bigint => devDb.resultSchemaVersion(db),

        // `data.write_allowed() -> i32`: 1 if the current call may write. Used by the
        // rewrite-on-read convergence after a lazy migration to persist the converged
        // row. The dev store permits writes, so return 1.
        'data.write_allowed': (): number => 1,
    };
}

/** Test-only: clear the stores + catalog + persistence between unit tests. */
export function __resetDbForTests(): void {
    devDb.resetForTests();
}

/** Test-only: seed the catalog (collection -> current schema_version) directly. */
export function __setDbCatalogForTests(entries: Record<string, number>): void {
    devDb.setCatalogForTests(entries);
}

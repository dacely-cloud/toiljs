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
import { createHash } from 'node:crypto';
import path from 'node:path';

import { DataReader, DataWriter } from 'toiljs/io';
import type { MemoryRef } from '../runtime/host.js';
import { parseCatalog } from './catalog.js';
import {
    ABSENT,
    ALREADY_EXISTS,
    type CapLedger,
    CODEC_ERR,
    CollectionFamily,
    CONFLICT,
    type DbCatalogState,
    type DbDevState,
    type DbSnapshot,
    DbFunctionKind,
    DEFAULT_FILL_WAIT_MS,
    type DevCollectionHandle,
    INVALID_HANDLE,
    MAX_KEY,
    MAX_FILL_WAIT_MS,
    MAX_NAME,
    MAX_RESERVATION_TTL_MS,
    MAX_RESERVATIONS,
    MAX_VALUE,
    OP_NOT_ALLOWED_FOR_FAMILY,
    OP_NOT_ALLOWED_IN_KIND,
    type RecordOutcomeSnapshot,
    type Reservation,
    satI64,
    SCHEMA_UNAVAILABLE,
    TOO_MANY_KEYS,
    TOO_SMALL,
    UNAVAILABLE,
    isCollectionFamily,
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

type RecordOutcome =
    | { kind: 'unit' }
    | { kind: 'value'; value: Buffer; schemaVersion: number }
    | { kind: 'absent' }
    | { kind: 'already_exists' }
    | { kind: 'not_found' }
    | { kind: 'conflict' };

interface RecordIdemRow {
    requestHash: string;
    outcome: RecordOutcome | null;
}

function readIdem(ref: MemoryRef, ptr: number): Buffer | null {
    if (ptr === 0) return null;
    return readCopy(ref, ptr, 16);
}

function u64le(n: number): Buffer {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
}

const RECORD_OP_CREATE = 4;
const RECORD_OP_PATCH = 5;
const RECORD_OP_DELETE = 6;
const RECORD_OP_GET_DELETE = 7;
const RECORD_OP_ENQUEUE = 8;

function recordRequestHash(op: number, key: Buffer, value: Buffer): string {
    return createHash('sha256')
        .update('toildb/record-idempotency/request/v1')
        .update(Buffer.from([op]))
        .update(u64le(key.length))
        .update(key)
        .update(u64le(value.length))
        .update(value)
        .digest('hex');
}

function idemKey(coll: DevCollectionHandle, key: Buffer, op: string, idem: Buffer): string {
    return `${storeKey(coll.name, key)}\0${op}\0${idem.toString('hex')}`;
}

function reservationIdFromIdem(coll: DevCollectionHandle, key: Buffer, idem: Buffer): bigint {
    const digest = createHash('sha256')
        .update('toildb/capacity-reservation-id/v1')
        .update(coll.name)
        .update('\0')
        .update(key)
        .update(idem)
        .digest();
    return digest.readBigUInt64LE(0) | (1n << 63n);
}

function snapshotOutcome(outcome: RecordOutcome): RecordOutcomeSnapshot {
    switch (outcome.kind) {
        case 'value':
            return {
                kind: 'value',
                v: outcome.value.toString('base64'),
                sv: outcome.schemaVersion,
            };
        default:
            return { kind: outcome.kind };
    }
}

function loadOutcome(outcome: RecordOutcomeSnapshot): RecordOutcome {
    if (outcome.kind === 'value') {
        return {
            kind: 'value',
            value: Buffer.from(outcome.v, 'base64'),
            schemaVersion: outcome.sv,
        };
    }
    return { kind: outcome.kind };
}

function collOf(db: DbDevState, handle: number): DevCollectionHandle | null {
    return handle >= 0 && handle < db.handles.length ? db.handles[handle] : null;
}

function collOfFamily(
    db: DbDevState,
    handle: number,
    ...families: CollectionFamily[]
): DevCollectionHandle | number {
    const coll = collOf(db, handle);
    if (coll === null) return INVALID_HANDLE;
    return families.includes(coll.family) ? coll : OP_NOT_ALLOWED_FOR_FAMILY;
}

enum DbOp {
    Get,
    GetMany,
    Exists,
    Create,
    Patch,
    Delete,
    GetDelete,
    Enqueue,
    Append,
    AppendOnce,
    Latest,
    CounterGet,
    CounterAdd,
    MembershipContains,
    MembershipAdd,
    MembershipRemove,
    MembershipList,
    UniqueLookup,
    UniqueClaim,
    UniqueRelease,
    CapacityAvailable,
    CapacityReserve,
    CapacityConfirm,
    CapacityCancel,
    ViewGet,
    ViewPublish,
    CapacitySetTotal,
}

function isReadOp(op: DbOp): boolean {
    return (
        op === DbOp.Get ||
        op === DbOp.GetMany ||
        op === DbOp.Exists ||
        op === DbOp.ViewGet ||
        op === DbOp.CounterGet ||
        op === DbOp.MembershipContains ||
        op === DbOp.MembershipList ||
        op === DbOp.UniqueLookup ||
        op === DbOp.Latest ||
        op === DbOp.CapacityAvailable
    );
}

function isScanOp(op: DbOp): boolean {
    return op === DbOp.Latest || op === DbOp.MembershipList;
}

function kindAllows(kind: DbFunctionKind, op: DbOp): boolean {
    if (kind === DbFunctionKind.Query) return isReadOp(op) && !isScanOp(op);
    if (kind === DbFunctionKind.Action) {
        return (
            (isReadOp(op) && !isScanOp(op)) ||
            op === DbOp.Create ||
            op === DbOp.Patch ||
            op === DbOp.Delete ||
            op === DbOp.GetDelete ||
            op === DbOp.Enqueue ||
            op === DbOp.Append ||
            op === DbOp.AppendOnce ||
            op === DbOp.CounterAdd ||
            op === DbOp.MembershipAdd ||
            op === DbOp.MembershipRemove ||
            op === DbOp.UniqueClaim ||
            op === DbOp.UniqueRelease ||
            op === DbOp.CapacityReserve ||
            op === DbOp.CapacityConfirm ||
            op === DbOp.CapacityCancel
        );
    }
    if (kind === DbFunctionKind.Derive)
        return (
            isReadOp(op) || op === DbOp.ViewPublish || op === DbOp.Append || op === DbOp.CounterAdd
        );
    if (kind === DbFunctionKind.Job) return true;
    return false;
}

function collForOp(
    db: DbDevState,
    handle: number,
    op: DbOp,
    ...families: CollectionFamily[]
): DevCollectionHandle | number {
    const coll = collOfFamily(db, handle, ...families);
    if (typeof coll === 'number') return coll;
    return kindAllows(db.functionKind, op) ? coll : OP_NOT_ALLOWED_IN_KIND;
}

type CatalogSeedEntry =
    | number
    | {
          family?: number;
          schemaVersion?: number;
          replication?: number;
          placement?: number;
          fillMaxWaitMs?: number;
          fillAllowStale?: boolean;
      };

/**
 * The single-process dev data store: the seven ToilDB families, their per-row
 * schema_versions, the loaded wasm's catalog, and optional on-disk persistence.
 * Process-lifetime, shared across dispatches via the module singleton {@link devDb}.
 */
export class DevDatabase {
    /** Process-lifetime store: `"collection\0keyLatin1"` -> value. Shared across dispatches. */
    private readonly store = new Map<string, Buffer>();
    /** Record-family idempotency claims/outcomes: collection+key+op+idem -> row. */
    private readonly recordIdem = new Map<string, RecordIdemRow>();
    /** Unique-claim request idempotency bytes: `"collection\0key"` -> hex idem. */
    private readonly uniqueIdem = new Map<string, string>();
    /** View family: `"collection\0key"` -> the latest published view blob. */
    private readonly views = new Map<string, Buffer>();
    /** Membership family: `"collection\0setKey"` -> (memberLatin1 -> member bytes). */
    private readonly members = new Map<string, Map<string, Buffer>>();
    /** Counter family: `"collection\0key"` -> saturating i64 sum of deltas. */
    private readonly counters = new Map<string, bigint>();
    /** Counter idempotency: collection+key+idem -> original delta. */
    private readonly counterIdem = new Map<string, bigint>();
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
    /** The decoded catalog from the loaded wasm, including family + current schema_version. */
    private catalog: DbCatalogState = { kind: 'no-section' };

    // ---- on-disk persistence: dev data + its versions survive restarts, so a
    // developer can write rows, evolve a @data type, restart, and watch the @migrate
    // run. Delete the file to reset the dev database. JSON with base64 buffers.
    private persistPath: string | null = null;

    /** (Re)load the catalog capability metadata from a server wasm. The module
     *  loader calls this on every (re)compile so writes stamp the live version. */
    setCatalog(wasm: Buffer): void {
        this.catalog = parseCatalog(wasm);
    }

    private currentSchemaVersion(coll: DevCollectionHandle): number {
        if (this.catalog.kind !== 'present') return coll.schemaVersion;
        return this.catalog.collections.get(coll.name)?.schemaVersion ?? coll.schemaVersion;
    }

    private stampVersion(coll: DevCollectionHandle, sk: string): void {
        this.versions.set(sk, this.currentSchemaVersion(coll)); // stamp the value type's current version
    }

    private recordIdemStart(
        coll: DevCollectionHandle,
        key: Buffer,
        op: string,
        idem: Buffer | null,
        requestHash: string,
    ): { fresh: true } | { fresh: false; status: number; outcome?: RecordOutcome } {
        if (idem === null) return { fresh: true };
        const ik = idemKey(coll, key, op, idem);
        const row = this.recordIdem.get(ik);
        if (row === undefined) {
            this.recordIdem.set(ik, { requestHash, outcome: null });
            return { fresh: true };
        }
        if (row.requestHash !== requestHash) return { fresh: false, status: CONFLICT };
        if (row.outcome === null) return { fresh: false, status: UNAVAILABLE };
        return { fresh: false, status: 0, outcome: row.outcome };
    }

    private recordIdemFinish(
        coll: DevCollectionHandle,
        key: Buffer,
        op: string,
        idem: Buffer | null,
        requestHash: string,
        outcome: RecordOutcome,
    ): void {
        if (idem === null) return;
        const ik = idemKey(coll, key, op, idem);
        const row = this.recordIdem.get(ik);
        if (row === undefined || row.requestHash !== requestHash) return;
        if (row.outcome === null) row.outcome = outcome;
    }

    private replayRecordOutcome(db: DbDevState, outcome: RecordOutcome): number {
        switch (outcome.kind) {
            case 'unit':
                return 0;
            case 'value':
                db.lastResult = outcome.value;
                db.lastResultVersion = outcome.schemaVersion;
                return outcome.value.length;
            case 'absent':
            case 'not_found':
                return ABSENT;
            case 'already_exists':
                return ALREADY_EXISTS;
            case 'conflict':
                return CONFLICT;
        }
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
            recordIdem: {},
            uniqueIdem: {},
            views: {},
            members: {},
            counters: {},
            counterIdem: {},
            events: {},
            eventDedup: {},
            capacity: {},
        };
        for (const [k, v] of this.store)
            snap.store[k] = { v: v.toString('base64'), sv: this.versions.get(k) ?? 0 };
        for (const [k, row] of this.recordIdem)
            snap.recordIdem![k] = {
                requestHash: row.requestHash,
                state: row.outcome === null ? 'pending' : 'done',
                outcome: row.outcome === null ? undefined : snapshotOutcome(row.outcome),
            };
        for (const [k, v] of this.uniqueIdem) snap.uniqueIdem![k] = v;
        for (const [k, v] of this.views)
            snap.views[k] = { v: v.toString('base64'), sv: this.versions.get(k) ?? 0 };
        for (const [k, m] of this.members) {
            const o: Record<string, { v: string; sv: number }> = {};
            const mv = this.memberVersions.get(k);
            for (const [mk, mvb] of m) o[mk] = { v: mvb.toString('base64'), sv: mv?.get(mk) ?? 0 };
            snap.members[k] = o;
        }
        for (const [k, v] of this.counters) snap.counters[k] = v.toString();
        for (const [k, v] of this.counterIdem) snap.counterIdem![k] = v.toString();
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
        for (const [k, row] of Object.entries(snap.recordIdem ?? {})) {
            this.recordIdem.set(k, {
                requestHash: row.requestHash,
                outcome:
                    row.state === 'done' && row.outcome !== undefined
                        ? loadOutcome(row.outcome)
                        : null,
            });
        }
        for (const [k, v] of Object.entries(snap.uniqueIdem ?? {})) this.uniqueIdem.set(k, v);
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
        for (const [k, v] of Object.entries(snap.counterIdem ?? {}))
            this.counterIdem.set(k, BigInt(v));
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
        this.recordIdem.clear();
        this.uniqueIdem.clear();
        this.versions.clear();
        this.views.clear();
        this.members.clear();
        this.memberVersions.clear();
        this.counters.clear();
        this.counterIdem.clear();
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
        let coll: DevCollectionHandle;
        switch (this.catalog.kind) {
            case 'present': {
                const found = this.catalog.collections.get(name);
                if (found === undefined) return SCHEMA_UNAVAILABLE;
                coll = { ...found };
                break;
            }
            case 'malformed':
                return SCHEMA_UNAVAILABLE;
            case 'no-section':
                coll = {
                    name,
                    family: CollectionFamily.Record,
                    schemaVersion: 0,
                    replication: 0,
                    placement: 0,
                    fillMaxWaitMs: DEFAULT_FILL_WAIT_MS,
                    fillAllowStale: true,
                };
                break;
        }
        const handle = db.handles.length;
        db.handles.push(coll);
        const m = mem(ref);
        if (outHandlePtr < 0 || outHandlePtr + 4 > m.length)
            throw new Error('data: resolve out-handle out of bounds');
        m.writeUInt32LE(handle, outHandlePtr);
        return 0;
    }

    get(ref: MemoryRef, db: DbDevState, handle: number, keyPtr: number, keyLen: number): number {
        const coll = collForOp(db, handle, DbOp.Get, CollectionFamily.Record);
        if (typeof coll === 'number') return coll;
        if (keyLen > MAX_KEY) throw new Error('data: key too long');
        const sk = storeKey(coll.name, readKey(ref, keyPtr, keyLen));
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
        const coll = collForOp(
            db,
            handle,
            DbOp.GetMany,
            CollectionFamily.Record,
            CollectionFamily.View,
        );
        if (typeof coll === 'number') return coll;
        if (keysLen > MAX_VALUE) throw new Error('data: keys blob too large');
        const table = coll.family === CollectionFamily.View ? this.views : this.store;
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
            const sk = storeKey(coll.name, Buffer.from(key));
            const v = table.get(sk);
            if (v === undefined) {
                w.writeU8(0);
            } else {
                w.writeU8(1)
                    .writeU32(this.versions.get(sk) ?? 0)
                    .writeBytes(v);
            }
        }
        db.lastResult = Buffer.from(w.toBytes());
        return db.lastResult.length;
    }

    exists(ref: MemoryRef, db: DbDevState, handle: number, keyPtr: number, keyLen: number): number {
        const coll = collForOp(db, handle, DbOp.Exists, CollectionFamily.Record);
        if (typeof coll === 'number') return coll;
        return this.store.has(storeKey(coll.name, readKey(ref, keyPtr, keyLen))) ? 1 : 0;
    }

    create(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        valPtr: number,
        valLen: number,
        idemPtr: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.Create, CollectionFamily.Record);
        if (typeof coll === 'number') return coll;
        if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/value too large');
        const key = readKey(ref, keyPtr, keyLen);
        const value = readCopy(ref, valPtr, valLen);
        const idem = readIdem(ref, idemPtr);
        const requestHash = recordRequestHash(RECORD_OP_CREATE, key, value);
        const start = this.recordIdemStart(coll, key, 'C', idem, requestHash);
        if (!start.fresh)
            return start.outcome ? this.replayRecordOutcome(db, start.outcome) : start.status;
        const sk = storeKey(coll.name, key);
        const outcome: RecordOutcome = this.store.has(sk)
            ? { kind: 'already_exists' }
            : { kind: 'unit' };
        if (outcome.kind === 'unit') {
            this.store.set(sk, value);
            this.stampVersion(coll, sk); // stamp the value type's current schema version
            this.recordWrite(db, coll);
        }
        this.recordIdemFinish(coll, key, 'C', idem, requestHash, outcome);
        return this.replayRecordOutcome(db, outcome);
    }

    patch(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        patchPtr: number,
        patchLen: number,
        idemPtr: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.Patch, CollectionFamily.Record);
        if (typeof coll === 'number') return coll;
        if (keyLen > MAX_KEY || patchLen > MAX_VALUE) throw new Error('data: key/patch too large');
        const key = readKey(ref, keyPtr, keyLen);
        const v = readCopy(ref, patchPtr, patchLen);
        const idem = readIdem(ref, idemPtr);
        const requestHash = recordRequestHash(RECORD_OP_PATCH, key, v);
        const start = this.recordIdemStart(coll, key, 'P', idem, requestHash);
        if (!start.fresh)
            return start.outcome ? this.replayRecordOutcome(db, start.outcome) : start.status;
        const sk = storeKey(coll.name, key);
        const outcome: RecordOutcome = this.store.has(sk)
            ? { kind: 'value', value: v, schemaVersion: this.currentSchemaVersion(coll) }
            : { kind: 'not_found' };
        if (outcome.kind === 'value') {
            this.store.set(sk, v);
            this.stampVersion(coll, sk); // a patch rewrites the row at the current version
            this.recordWrite(db, coll);
        }
        this.recordIdemFinish(coll, key, 'P', idem, requestHash, outcome);
        return this.replayRecordOutcome(db, outcome);
    }

    delete(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        idemPtr: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.Delete, CollectionFamily.Record);
        if (typeof coll === 'number') return coll;
        const key = readKey(ref, keyPtr, keyLen);
        const idem = readIdem(ref, idemPtr);
        const requestHash = recordRequestHash(RECORD_OP_DELETE, key, Buffer.alloc(0));
        const start = this.recordIdemStart(coll, key, 'D', idem, requestHash);
        if (!start.fresh)
            return start.outcome ? this.replayRecordOutcome(db, start.outcome) : start.status;
        const sk = storeKey(coll.name, key);
        this.store.delete(sk);
        this.versions.delete(sk);
        const outcome: RecordOutcome = { kind: 'unit' };
        this.recordIdemFinish(coll, key, 'D', idem, requestHash, outcome);
        return this.replayRecordOutcome(db, outcome);
    }

    // Atomic fetch-and-delete (consume-once); deletes only on a real read.
    getDelete(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        idemPtr: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.GetDelete, CollectionFamily.Record);
        if (typeof coll === 'number') return coll;
        const key = readKey(ref, keyPtr, keyLen);
        const idem = readIdem(ref, idemPtr);
        const requestHash = recordRequestHash(RECORD_OP_GET_DELETE, key, Buffer.alloc(0));
        const start = this.recordIdemStart(coll, key, 'G', idem, requestHash);
        if (!start.fresh)
            return start.outcome ? this.replayRecordOutcome(db, start.outcome) : start.status;
        const sk = storeKey(coll.name, key);
        const v = this.store.get(sk);
        const outcome: RecordOutcome =
            v === undefined
                ? { kind: 'absent' }
                : {
                      kind: 'value',
                      value: v,
                      schemaVersion: this.versions.get(sk) ?? 0,
                  };
        if (outcome.kind === 'value') {
            this.store.delete(sk);
            this.versions.delete(sk);
        }
        this.recordIdemFinish(coll, key, 'G', idem, requestHash, outcome);
        return this.replayRecordOutcome(db, outcome);
    }

    // --- unique family (lookup / claim / release) ---

    uniqueLookup(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.UniqueLookup, CollectionFamily.Unique);
        if (typeof coll === 'number') return coll;
        const sk = storeKey(coll.name, readKey(ref, keyPtr, keyLen));
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
        idemPtr: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.UniqueClaim, CollectionFamily.Unique);
        if (typeof coll === 'number') return coll;
        if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/value too large');
        const sk = storeKey(coll.name, readKey(ref, keyPtr, keyLen));
        const owner = readCopy(ref, valPtr, valLen);
        const idem = readIdem(ref, idemPtr)?.toString('hex') ?? '';
        const existing = this.store.get(sk);
        if (existing === undefined) {
            this.store.set(sk, owner);
            this.uniqueIdem.set(sk, idem);
            this.stampVersion(coll, sk);
            return 0; // Claimed
        }
        if (existing.equals(owner)) {
            return (this.uniqueIdem.get(sk) ?? '') === idem ? 2 : CONFLICT;
        }
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
        const coll = collForOp(db, handle, DbOp.UniqueRelease, CollectionFamily.Unique);
        if (typeof coll === 'number') return coll;
        const sk = storeKey(coll.name, readKey(ref, keyPtr, keyLen));
        const existing = this.store.get(sk);
        if (existing === undefined) return 0; // idempotent
        if (!existing.equals(readCopy(ref, valPtr, valLen))) return CONFLICT; // not the owner
        this.store.delete(sk);
        this.uniqueIdem.delete(sk);
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
        const coll = collForOp(db, handle, DbOp.MembershipContains, CollectionFamily.Membership);
        if (typeof coll === 'number') return coll;
        const set = this.members.get(storeKey(coll.name, readKey(ref, setPtr, setLen)));
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
        const coll = collForOp(db, handle, DbOp.MembershipAdd, CollectionFamily.Membership);
        if (typeof coll === 'number') return coll;
        if (setLen > MAX_KEY || memberLen > MAX_VALUE)
            throw new Error('data: set/member too large');
        const sk = storeKey(coll.name, readKey(ref, setPtr, setLen));
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
        mv.set(ml, this.currentSchemaVersion(coll));
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
        const coll = collForOp(db, handle, DbOp.MembershipRemove, CollectionFamily.Membership);
        if (typeof coll === 'number') return coll;
        const sk = storeKey(coll.name, readKey(ref, setPtr, setLen));
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
        const coll = collForOp(db, handle, DbOp.MembershipList, CollectionFamily.Membership);
        if (typeof coll === 'number') return coll;
        const sk = storeKey(coll.name, readKey(ref, setPtr, setLen));
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
        const coll = collForOp(db, handle, DbOp.ViewGet, CollectionFamily.View);
        if (typeof coll === 'number') return coll;
        const sk = storeKey(coll.name, readKey(ref, keyPtr, keyLen));
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
        const coll = collForOp(db, handle, DbOp.ViewPublish, CollectionFamily.View);
        if (typeof coll === 'number') return coll;
        if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/view too large');
        const sk = storeKey(coll.name, readKey(ref, keyPtr, keyLen));
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
        const coll = collForOp(db, handle, DbOp.CounterGet, CollectionFamily.Counter);
        if (typeof coll === 'number') return coll;
        const sum = this.counters.get(storeKey(coll.name, readKey(ref, keyPtr, keyLen))) ?? 0n;
        const out = Buffer.alloc(8);
        out.writeBigInt64LE(sum);
        db.lastResult = out;
        return out.length;
    }

    // `delta` is the wasm i64 (a BigInt across the boundary); `BigInt()`
    // normalizes the test's plain-number form too. Saturates like the edge.
    /** Note a successful write to a SOURCE collection, so the runtime can re-run
     *  the `@derive` materializers that depend on it after this dispatch. A
     *  derive's OWN writes run under FunctionKind=Derive and must never
     *  re-trigger a derive (which would loop), so they are never recorded. */
    private recordWrite(db: DbDevState, coll: DevCollectionHandle): void {
        if (db.functionKind === DbFunctionKind.Derive) return;
        db.writtenCollections.add(coll.name);
    }

    counterAdd(
        ref: MemoryRef,
        db: DbDevState,
        handle: number,
        keyPtr: number,
        keyLen: number,
        delta: number | bigint,
        idemPtr: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.CounterAdd, CollectionFamily.Counter);
        if (typeof coll === 'number') return coll;
        const key = readKey(ref, keyPtr, keyLen);
        const idem = readIdem(ref, idemPtr);
        const d = BigInt(delta);
        if (idem !== null) {
            const ik = idemKey(coll, key, 'A', idem);
            const seen = this.counterIdem.get(ik);
            if (seen !== undefined) return seen === d ? 0 : CONFLICT;
            this.counterIdem.set(ik, d);
        }
        const sk = storeKey(coll.name, key);
        this.counters.set(sk, satI64((this.counters.get(sk) ?? 0n) + d));
        this.recordWrite(db, coll);
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
        idemPtr: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.Append, CollectionFamily.Events);
        if (typeof coll === 'number') return coll;
        if (keyLen > MAX_KEY || evLen > MAX_VALUE) throw new Error('data: key/event too large');
        const key = readKey(ref, keyPtr, keyLen);
        const sk = storeKey(coll.name, key);
        const idem = readIdem(ref, idemPtr);
        if (idem !== null) {
            let seen = this.eventDedup.get(sk);
            if (seen === undefined) {
                seen = new Set();
                this.eventDedup.set(sk, seen);
            }
            const eventId = idem.toString('latin1');
            if (seen.has(eventId)) return 0;
            seen.add(eventId);
        }
        const log = this.events.get(sk);
        const ev = readCopy(ref, evPtr, evLen);
        const sv = this.currentSchemaVersion(coll);
        if (log === undefined) {
            this.events.set(sk, [ev]);
            this.eventVersions.set(sk, [sv]);
        } else {
            log.push(ev);
            (this.eventVersions.get(sk) ?? this.eventVersions.set(sk, []).get(sk)!).push(sv);
        }
        this.recordWrite(db, coll);
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
        const coll = collForOp(db, handle, DbOp.AppendOnce, CollectionFamily.Events);
        if (typeof coll === 'number') return coll;
        if (keyLen > MAX_KEY || evLen > MAX_VALUE) throw new Error('data: key/event too large');
        const sk = storeKey(coll.name, readKey(ref, keyPtr, keyLen));
        const evid = readCopy(ref, evidPtr, evidLen).toString('latin1');
        let seen = this.eventDedup.get(sk);
        if (seen === undefined) {
            seen = new Set();
            this.eventDedup.set(sk, seen);
        }
        if (seen.has(evid)) return 0; // already appended under this id
        const ev = readCopy(ref, evPtr, evLen);
        const sv = this.currentSchemaVersion(coll);
        const log = this.events.get(sk);
        if (log === undefined) {
            this.events.set(sk, [ev]);
            this.eventVersions.set(sk, [sv]);
        } else {
            log.push(ev);
            (this.eventVersions.get(sk) ?? this.eventVersions.set(sk, []).get(sk)!).push(sv);
        }
        seen.add(evid);
        this.recordWrite(db, coll);
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
        idemPtr: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.Enqueue, CollectionFamily.Record);
        if (typeof coll === 'number') return coll;
        if (keyLen > MAX_KEY || valLen > MAX_VALUE) throw new Error('data: key/value too large');
        const key = readKey(ref, keyPtr, keyLen);
        const value = readCopy(ref, valPtr, valLen);
        const idem = readIdem(ref, idemPtr);
        const requestHash = recordRequestHash(RECORD_OP_ENQUEUE, key, value);
        const start = this.recordIdemStart(coll, key, 'E', idem, requestHash);
        if (!start.fresh)
            return start.outcome ? this.replayRecordOutcome(db, start.outcome) : start.status;
        const sk = storeKey(coll.name, key);
        const outcome: RecordOutcome = this.store.has(sk)
            ? { kind: 'unit' }
            : { kind: 'not_found' };
        if (outcome.kind === 'unit') {
            this.store.set(sk, value);
            this.stampVersion(coll, sk);
        }
        this.recordIdemFinish(coll, key, 'E', idem, requestHash, outcome);
        return this.replayRecordOutcome(db, outcome);
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
        const coll = collForOp(db, handle, DbOp.Latest, CollectionFamily.Events);
        if (typeof coll === 'number') return coll;
        const sk = storeKey(coll.name, readKey(ref, keyPtr, keyLen));
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
        const coll = collForOp(db, handle, DbOp.CapacitySetTotal, CollectionFamily.Capacity);
        if (typeof coll === 'number') return coll;
        const l = this.capLedger(storeKey(coll.name, readKey(ref, keyPtr, keyLen)));
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
        const coll = collForOp(db, handle, DbOp.CapacityAvailable, CollectionFamily.Capacity);
        if (typeof coll === 'number') return coll;
        const l = this.capLedger(storeKey(coll.name, readKey(ref, keyPtr, keyLen)));
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
        idemPtr: number,
    ): number {
        const coll = collForOp(db, handle, DbOp.CapacityReserve, CollectionFamily.Capacity);
        if (typeof coll === 'number') return coll;
        const want = BigInt(amount);
        if (want <= 0n) return CODEC_ERR; // BadAmount (edge: -1006)
        const key = readKey(ref, keyPtr, keyLen);
        const idem = readIdem(ref, idemPtr);
        const ttl = Math.min(Math.max(0, Number(ttlMs)), MAX_RESERVATION_TTL_MS);
        const requestedId = idem === null ? null : reservationIdFromIdem(coll, key, idem);
        const l = this.capLedger(storeKey(coll.name, key));
        const now = Date.now();
        this.capPrune(l, now);
        if (requestedId !== null) {
            const existing = l.reservations.get(requestedId);
            if (existing !== undefined) {
                if (existing.amount !== want) return CONFLICT;
                const out = Buffer.alloc(8);
                out.writeBigUInt64LE(requestedId);
                db.lastResult = out;
                return out.length;
            }
        }
        if (l.total - this.capReserved(l) < want || l.reservations.size >= MAX_RESERVATIONS)
            return ABSENT; // never oversell; bound the reservation count
        const id = requestedId ?? l.nextId++;
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
        const coll = collForOp(db, handle, DbOp.CapacityConfirm, CollectionFamily.Capacity);
        if (typeof coll === 'number') return coll;
        const l = this.capLedger(storeKey(coll.name, readKey(ref, keyPtr, keyLen)));
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
        const coll = collForOp(db, handle, DbOp.CapacityCancel, CollectionFamily.Capacity);
        if (typeof coll === 'number') return coll;
        const l = this.capLedger(storeKey(coll.name, readKey(ref, keyPtr, keyLen)));
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
        this.catalog = { kind: 'no-section' };
        this.persistPath = null;
    }

    /** Test-only: seed the catalog directly. Number values default to record-family entries. */
    setCatalogForTests(entries: Record<string, CatalogSeedEntry>): void {
        const collections = new Map<string, DevCollectionHandle>();
        for (const [name, entry] of Object.entries(entries)) {
            const schemaVersion = typeof entry === 'number' ? entry : (entry.schemaVersion ?? 0);
            const family =
                typeof entry === 'number'
                    ? CollectionFamily.Record
                    : (entry.family ?? CollectionFamily.Record);
            const replication = typeof entry === 'number' ? 0 : (entry.replication ?? 0);
            const placement = typeof entry === 'number' ? 0 : (entry.placement ?? 0);
            const fillMaxWaitMs =
                typeof entry === 'number'
                    ? DEFAULT_FILL_WAIT_MS
                    : (entry.fillMaxWaitMs ?? DEFAULT_FILL_WAIT_MS);
            const fillAllowStale =
                typeof entry === 'number' ? true : (entry.fillAllowStale ?? true);
            if (!isCollectionFamily(family)) {
                this.catalog = { kind: 'malformed' };
                return;
            }
            if (fillMaxWaitMs > MAX_FILL_WAIT_MS) {
                this.catalog = { kind: 'malformed' };
                return;
            }
            collections.set(name, {
                name,
                family,
                schemaVersion: schemaVersion >>> 0,
                replication,
                placement,
                fillMaxWaitMs,
                fillAllowStale,
            });
        }
        this.catalog = { kind: 'present', collections };
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
            idemPtr: number,
        ): number => devDb.create(ref, db, handle, keyPtr, keyLen, valPtr, valLen, idemPtr),

        'data.patch': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            patchPtr: number,
            patchLen: number,
            idemPtr: number,
        ): number => devDb.patch(ref, db, handle, keyPtr, keyLen, patchPtr, patchLen, idemPtr),

        'data.delete': (handle: number, keyPtr: number, keyLen: number, idemPtr: number): number =>
            devDb.delete(ref, db, handle, keyPtr, keyLen, idemPtr),

        'data.get_delete': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            idemPtr: number,
        ): number => devDb.getDelete(ref, db, handle, keyPtr, keyLen, idemPtr),

        'data.unique_lookup': (handle: number, keyPtr: number, keyLen: number): number =>
            devDb.uniqueLookup(ref, db, handle, keyPtr, keyLen),

        'data.unique_claim': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            valPtr: number,
            valLen: number,
            idemPtr: number,
        ): number => devDb.uniqueClaim(ref, db, handle, keyPtr, keyLen, valPtr, valLen, idemPtr),

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
            idemPtr: number,
        ): number => devDb.counterAdd(ref, db, handle, keyPtr, keyLen, delta, idemPtr),

        'data.append': (
            handle: number,
            keyPtr: number,
            keyLen: number,
            evPtr: number,
            evLen: number,
            idemPtr: number,
        ): number => devDb.append(ref, db, handle, keyPtr, keyLen, evPtr, evLen, idemPtr),

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
            idemPtr: number,
        ): number => devDb.enqueue(ref, db, handle, keyPtr, keyLen, valPtr, valLen, idemPtr),

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
            idemPtr: number,
        ): number => devDb.capacityReserve(ref, db, handle, keyPtr, keyLen, amount, ttlMs, idemPtr),

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

        // `data.write_allowed() -> i32`: 1 if the current call may issue the
        // record patch used by rewrite-on-read migration convergence.
        'data.write_allowed': (): number => (kindAllows(db.functionKind, DbOp.Patch) ? 1 : 0),
    };
}

/** Test-only: clear the stores + catalog + persistence between unit tests. */
export function __resetDbForTests(): void {
    devDb.resetForTests();
}

/** Test-only: seed the catalog directly. Number values default to record-family entries. */
export function __setDbCatalogForTests(entries: Record<string, CatalogSeedEntry>): void {
    devDb.setCatalogForTests(entries);
}

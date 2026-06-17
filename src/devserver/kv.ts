/**
 * DEV-ONLY persistent key-value store host imports (`env::kv.*`).
 *
 * ============================ REMOVE KV LATER ============================
 * This exists ONLY so the post-quantum auth example can run the full
 * register -> login chain end-to-end under `toiljs dev`. A tenant's wasm linear
 * memory is wiped after every request, so account records and login challenges
 * cannot live in the guest across the two round trips; they need an external
 * store. This module is a single-process `Map` standing in for that store.
 *
 * It is intentionally NOT registered on the production Rust edge
 * (`toil-backend` `HOST_IMPORTS`), so a module using `kv.*` will not instantiate
 * there. REPLACE THIS once toildb is implemented: move the example's account +
 * challenge stores onto toildb (which provides the atomic fetch-and-delete the
 * challenge consume needs) and delete this whole module. DO NOT ship this `Map`
 * as a production storage path: it is single-instance, unbounded, and lost on
 * restart.
 * ========================================================================
 *
 * Wire ABI (mirrors the crypto imports' caller-allocated-buffer convention):
 *   kv.put(keyPtr, keyLen, valPtr, valLen)            -> void
 *   kv.get(keyPtr, keyLen, outPtr, outCap)            -> i32 len | -1 absent | -2 too small
 *   kv.getdel(keyPtr, keyLen, outPtr, outCap)         -> i32 len | -1 absent | -2 too small
 * `getdel` is the atomic fetch-and-delete used to consume a login challenge
 * exactly once; it deletes only on a successful read (never on a -2 probe).
 */

import type { MemoryRef } from './host.js';

/** Process-lifetime store, shared across every dispatch (the whole point). */
const STORE = new Map<string, Buffer>();

/** Hard cap on a single value (bounds the dev process RAM). Account records are
 *  ~1.5 KiB (1312-byte ML-DSA key + salt + params); 64 KiB is generous. */
const MAX_VALUE_BYTES = 64 * 1024;
/** Hard cap on a key. */
const MAX_KEY_BYTES = 1024;

function mem(ref: MemoryRef): Buffer {
    if (!ref.memory) throw new Error('kv host import called before memory was bound');
    return Buffer.from(ref.memory.buffer);
}

function readBytes(ref: MemoryRef, ptr: number, len: number): Buffer {
    const m = mem(ref);
    if (ptr < 0 || len < 0 || ptr + len > m.length)
        throw new Error(`kv read out of bounds: ptr=${String(ptr)} len=${String(len)}`);
    return Buffer.from(m.subarray(ptr, ptr + len)); // copy out
}

/** Map key from raw guest bytes (latin1 is a lossless 1:1 byte<->char mapping). */
function keyOf(ref: MemoryRef, ptr: number, len: number): string {
    if (len > MAX_KEY_BYTES) throw new Error(`kv key too long: ${String(len)} bytes`);
    return readBytes(ref, ptr, len).toString('latin1');
}

/** Write a stored value into the caller buffer (if it fits) and return its
 *  length; -1 if absent, -2 if the value exceeds `outCap` (no write, no delete). */
function emit(ref: MemoryRef, value: Buffer | undefined, outPtr: number, outCap: number): number {
    if (value === undefined) return -1;
    if (value.length > outCap) return -2;
    const m = mem(ref);
    if (outPtr < 0 || outPtr + value.length > m.length)
        throw new Error('kv get write out of bounds');
    value.copy(m, outPtr);
    return value.length;
}

export function buildKvImports(ref: MemoryRef): Record<string, (...args: number[]) => number | void> {
    return {
        'kv.put': (keyPtr: number, keyLen: number, valPtr: number, valLen: number): void => {
            if (valLen > MAX_VALUE_BYTES) throw new Error(`kv value too long: ${String(valLen)} bytes`);
            STORE.set(keyOf(ref, keyPtr, keyLen), readBytes(ref, valPtr, valLen));
        },

        'kv.get': (keyPtr: number, keyLen: number, outPtr: number, outCap: number): number => {
            return emit(ref, STORE.get(keyOf(ref, keyPtr, keyLen)), outPtr, outCap);
        },

        // Atomic fetch-and-delete: deletes ONLY when the value is actually
        // returned (a -2 "buffer too small" probe leaves the entry intact), so a
        // login challenge is consumed exactly once.
        'kv.getdel': (keyPtr: number, keyLen: number, outPtr: number, outCap: number): number => {
            const key = keyOf(ref, keyPtr, keyLen);
            const value = STORE.get(key);
            const n = emit(ref, value, outPtr, outCap);
            if (n >= 0) STORE.delete(key);
            return n;
        },
    };
}

/** Test-only: clear the store between unit tests. */
export function __resetKvForTests(): void {
    STORE.clear();
}

/**
 * Dev MemoryStore: a single in-memory `Map` with per-entry TTL, one per process,
 * persisted nowhere (ephemeral by definition). Backs the `mstore.*` host imports
 * (RECONCILIATION Part 4, F2: HANDLELESS, ttl in SECONDS, inline drain). Keys are
 * auto-scoped to host+region; the dev process is one host/region, so the key is
 * used verbatim. Shared by streams (Phase 4) AND the daemon (both reference the
 * same `devMemoryStore` singleton), matching doc 06's "shared across
 * streams/handlers on the same region".
 *
 * TTL is enforced LAZILY on read (no background sweep), mirroring the dev DB's
 * no-background-thread design. The error space is RECONCILIATION Part 3's 0x03xx
 * registry; the host-import layer (daemon/host.ts) maps these results onto the
 * Part 3 negative-return bridge.
 */

interface MStoreEntry {
    value: Buffer;
    /** `0` means no TTL; otherwise the epoch-ms the entry expires at. */
    expiresAtMs: number;
}

export class DevMemoryStore {
    private readonly map = new Map<string, MStoreEntry>();

    private now(): number {
        return Date.now();
    }

    /** The live entry for `key`, collecting it lazily if its TTL has passed. */
    private live(key: string): MStoreEntry | null {
        const e = this.map.get(key);
        if (e === undefined) return null;
        if (e.expiresAtMs !== 0 && e.expiresAtMs <= this.now()) {
            this.map.delete(key);
            return null;
        }
        return e;
    }

    private exp(ttlSecs: number): number {
        return ttlSecs > 0 ? this.now() + ttlSecs * 1000 : 0;
    }

    /** The value, or `null` (=> 0x0301 MSTORE_NOT_FOUND). */
    get(key: string): Buffer | null {
        const e = this.live(key);
        return e ? e.value : null;
    }

    set(key: string, value: Buffer, ttlSecs: number): void {
        this.map.set(key, { value: Buffer.from(value), expiresAtMs: this.exp(ttlSecs) });
    }

    delete(key: string): boolean {
        return this.map.delete(key);
    }

    /** Add `delta` to the i64 stored at `key`; `null` => 0x0306 MSTORE_NOT_A_NUMBER. */
    incr(key: string, delta: bigint, ttlSecs: number): bigint | null {
        const e = this.live(key);
        let cur = 0n;
        if (e !== null) {
            const s = e.value.toString('utf8').trim();
            if (!/^-?\d+$/.test(s)) return null;
            try {
                cur = BigInt(s);
            } catch {
                return null;
            }
        }
        const next = BigInt.asIntN(64, cur + delta);
        this.map.set(key, {
            value: Buffer.from(next.toString(), 'utf8'),
            // An incr on an existing key keeps its TTL unless a new one is given.
            expiresAtMs: ttlSecs > 0 ? this.exp(ttlSecs) : (e?.expiresAtMs ?? 0),
        });
        return next;
    }

    /** `expect === null` means expect-absent (the dev mapping of `expect_len == 0`).
     *  Returns `false` => 0x0304 MSTORE_CONFLICT. */
    cas(key: string, expect: Buffer | null, next: Buffer, ttlSecs: number): boolean {
        const e = this.live(key);
        if (expect === null) {
            if (e !== null) return false; // expect-absent, but present
        } else if (e === null || !e.value.equals(expect)) {
            return false; // expect-match failed
        }
        this.map.set(key, { value: Buffer.from(next), expiresAtMs: this.exp(ttlSecs) });
        return true;
    }

    /** Re-arm the TTL of a live key; `false` => key absent (0x0301). */
    expire(key: string, ttlSecs: number): boolean {
        const e = this.live(key);
        if (!e) return false;
        e.expiresAtMs = this.exp(ttlSecs);
        return true;
    }

    /**
     * Prefix walk. `cursor` is an opaque resume index; a stale cursor (one that
     * points past the current live key set after deletions) returns `null`
     * (=> 0x0307 MSTORE_SCAN_BUSY). Returns the next cursor + the matched keys.
     */
    scan(prefix: string, cursor: bigint): { next: bigint; keys: string[] } | null {
        const live = [...this.map.keys()].filter((k) => this.live(k) !== null && k.startsWith(prefix));
        live.sort();
        const start = Number(cursor);
        if (start < 0 || start > live.length) return null; // stale cursor
        const batch = live.slice(start);
        return { next: BigInt(live.length), keys: batch };
    }

    /** Test-only: drop all entries. */
    __reset(): void {
        this.map.clear();
    }
}

export const devMemoryStore = new DevMemoryStore();

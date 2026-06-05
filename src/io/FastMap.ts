/** A key usable with {@link FastMap}: any `PropertyKey` plus `bigint`. */
export type PropertyExtendedKey = PropertyKey | bigint;

/**
 * Like Record, but supports bigint keys (which JS auto-converts to strings).
 * Reflects actual JavaScript behavior where obj[123n] becomes obj["123"].
 */
export type FastRecord<V> = {
    [key: string]: V;
};

/** The string/number form a key takes once used to index the backing object. */
export type IndexKey = string | number;

/**
 * An insertion-ordered map backed by a key array plus a plain object, supporting
 * `bigint` keys (coerced to their string form, like native property access). Exposed
 * to the client as a global (no import). Implements `Disposable`, so a `using` binding
 * clears it on scope exit.
 */
export class FastMap<K extends PropertyExtendedKey, V> implements Disposable {
    protected _keys: K[] = [];
    protected _values: FastRecord<V> = {};

    /** @param iterable - initial entries, or another FastMap to copy. */
    constructor(iterable?: ReadonlyArray<readonly [K, V]> | null | FastMap<K, V>) {
        if (iterable instanceof FastMap) {
            this.setAll(iterable);
        } else {
            if (iterable) {
                for (const [key, value] of iterable) {
                    this.set(key, value);
                }
            }
        }
    }

    /** Number of entries. */
    public get size(): number {
        return this._keys.length;
    }

    /** Replaces all entries with a copy of `map`'s entries. */
    public setAll(map: FastMap<K, V>): void {
        this._keys = [...map._keys];
        this._values = { ...map._values };
    }

    /** Merges `map`'s entries into this one (existing keys are overwritten). */
    public addAll(map: FastMap<K, V>): void {
        for (const [key, value] of map.entries()) {
            this.set(key, value);
        }
    }

    /** Iterates the keys in insertion order. */
    public *keys(): IterableIterator<K> {
        yield* this._keys;
    }

    /** Iterates the values in key-insertion order. */
    public *values(): IterableIterator<V> {
        for (const key of this._keys) {
            yield this._values[key as IndexKey] as V;
        }
    }

    /** Iterates `[key, value]` pairs in insertion order. */
    public *entries(): IterableIterator<[K, V]> {
        for (const key of this._keys) {
            yield [key, this._values[key as IndexKey] as V];
        }
    }

    /** Sets `key` to `value` (appending the key if new), and returns `this` for chaining. */
    public set(key: K, value: V): this {
        if (!this.has(key)) {
            this._keys.push(key);
        }

        this._values[key as IndexKey] = value;

        return this;
    }

    /** Returns the insertion index of `key`, or -1 if absent. */
    public indexOf(key: K): number {
        if (!this.has(key)) {
            return -1;
        }

        for (let i = 0; i < this._keys.length; i++) {
            if (this._keys[i] === key) {
                return i;
            }
        }

        throw new Error('Key not found, this should not happen.');
    }

    /** Returns the value for `key`, or `undefined` if absent. */
    public get(key: K): V | undefined {
        return this._values[key as IndexKey];
    }

    /** Whether `key` is present. */
    public has(key: K): boolean {
        return Object.prototype.hasOwnProperty.call(this._values, key as IndexKey);
    }

    /** Removes `key`; returns true if it was present. */
    public delete(key: K): boolean {
        if (!this.has(key)) {
            return false;
        }

        const index = this.indexOf(key);
        this._keys.splice(index, 1);

        delete this._values[key as IndexKey];
        return true;
    }

    /** Removes all entries. */
    public clear(): void {
        this._keys = [];
        this._values = {};
    }

    /** `Disposable` hook: clears the map (so `using m = new FastMap()` frees it on scope exit). */
    public [Symbol.dispose](): void {
        this.clear();
    }

    /** Calls `callback(value, key, map)` for each entry in insertion order. */
    public forEach(
        callback: (value: V, key: K, map: FastMap<K, V>) => void,
        thisArg?: unknown,
    ): void {
        for (const key of this._keys) {
            callback.call(thisArg, this._values[key as IndexKey] as V, key, this);
        }
    }

    /** Default iterator: `[key, value]` pairs in insertion order. */
    *[Symbol.iterator](): IterableIterator<[K, V]> {
        for (const key of this._keys) {
            yield [key, this._values[key as IndexKey] as V];
        }
    }
}

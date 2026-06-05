import { type FastRecord, type IndexKey, type PropertyExtendedKey } from './FastMap.js';

/**
 * The Set counterpart to {@link FastMap}: an insertion-ordered set backed by an array (for
 * iteration/ordering) plus a record index (for O(1) membership), with bigint-key support.
 *
 * Authored to match FastMap's design, the upstream package ships no `FastSet`. Implements
 * `Disposable`, so a `using` binding clears it on scope exit.
 */
export class FastSet<T extends PropertyExtendedKey> implements Disposable {
    protected _values: T[] = [];
    protected _index: FastRecord<true> = {};

    /** @param iterable - initial values, or another FastSet to copy. */
    constructor(iterable?: Iterable<T> | null | FastSet<T>) {
        if (iterable instanceof FastSet) {
            this.addAll(iterable);
        } else if (iterable) {
            for (const value of iterable) {
                this.add(value);
            }
        }
    }

    /** Number of values. */
    public get size(): number {
        return this._values.length;
    }

    /** Adds `value` if not already present, and returns `this` for chaining. */
    public add(value: T): this {
        if (!this.has(value)) {
            this._values.push(value);
            this._index[value as IndexKey] = true;
        }

        return this;
    }

    /** Whether `value` is present (O(1)). */
    public has(value: T): boolean {
        return Object.prototype.hasOwnProperty.call(this._index, value as IndexKey);
    }

    /** Returns the insertion index of `value`, or -1 if absent. */
    public indexOf(value: T): number {
        for (let i = 0; i < this._values.length; i++) {
            if (this._values[i] === value) {
                return i;
            }
        }

        return -1;
    }

    /** Removes `value`; returns true if it was present. */
    public delete(value: T): boolean {
        if (!this.has(value)) {
            return false;
        }

        const index = this.indexOf(value);
        if (index !== -1) {
            this._values.splice(index, 1);
        }

        delete this._index[value as IndexKey];
        return true;
    }

    /** Adds every value from `set`. */
    public addAll(set: FastSet<T>): void {
        for (const value of set.values()) {
            this.add(value);
        }
    }

    /** Iterates the values in insertion order. */
    public *values(): IterableIterator<T> {
        yield* this._values;
    }

    /** Iterates the values in insertion order (alias of {@link values}, for Map-like parity). */
    public *keys(): IterableIterator<T> {
        yield* this._values;
    }

    /** Calls `callback(value, value, set)` for each value in insertion order. */
    public forEach(
        callback: (value: T, value2: T, set: FastSet<T>) => void,
        thisArg?: unknown,
    ): void {
        for (const value of this._values) {
            callback.call(thisArg, value, value, this);
        }
    }

    /** Removes all values. */
    public clear(): void {
        this._values = [];
        this._index = {};
    }

    /** `Disposable` hook: clears the set (so `using s = new FastSet()` frees it on scope exit). */
    public [Symbol.dispose](): void {
        this.clear();
    }

    /** Default iterator: the values in insertion order. */
    *[Symbol.iterator](): IterableIterator<T> {
        yield* this._values;
    }
}

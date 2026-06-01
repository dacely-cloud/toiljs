import { type FastRecord, type IndexKey, type PropertyExtendedKey } from './FastMap.js';

/**
 * The Set counterpart to {@link FastMap}: an insertion-ordered set backed by an array (for
 * iteration/ordering) plus a record index (for O(1) membership), with bigint-key support.
 *
 * Authored to match FastMap's design, the upstream package ships no `FastSet`.
 */
export class FastSet<T extends PropertyExtendedKey> implements Disposable {
    protected _values: T[] = [];
    protected _index: FastRecord<true> = {};

    constructor(iterable?: Iterable<T> | null | FastSet<T>) {
        if (iterable instanceof FastSet) {
            this.addAll(iterable);
        } else if (iterable) {
            for (const value of iterable) {
                this.add(value);
            }
        }
    }

    public get size(): number {
        return this._values.length;
    }

    public add(value: T): this {
        if (!this.has(value)) {
            this._values.push(value);
            this._index[value as IndexKey] = true;
        }

        return this;
    }

    public has(value: T): boolean {
        return Object.prototype.hasOwnProperty.call(this._index, value as IndexKey);
    }

    public indexOf(value: T): number {
        for (let i = 0; i < this._values.length; i++) {
            if (this._values[i] === value) {
                return i;
            }
        }

        return -1;
    }

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

    public addAll(set: FastSet<T>): void {
        for (const value of set.values()) {
            this.add(value);
        }
    }

    public *values(): IterableIterator<T> {
        yield* this._values;
    }

    public *keys(): IterableIterator<T> {
        yield* this._values;
    }

    public forEach(callback: (value: T, value2: T, set: FastSet<T>) => void, thisArg?: unknown): void {
        for (const value of this._values) {
            callback.call(thisArg, value, value, this);
        }
    }

    public clear(): void {
        this._values = [];
        this._index = {};
    }

    public [Symbol.dispose](): void {
        this.clear();
    }

    *[Symbol.iterator](): IterableIterator<T> {
        yield* this._values;
    }
}

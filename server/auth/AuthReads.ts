import { toildbHost } from 'bindings/toildb';
/** An unavailable security record must never be mistaken for an absent restriction. */
export class AuthReads {
    /** Keep original owner bytes: append-only schema decoding can otherwise
     * re-encode an old claim differently and make its release fail forever. */
    public static ownerSnapshot<K, V>(handle: u32, key: K): DocumentSnapshot<V> | null {
        const encodedKey = key.encode();
        const size = toildbHost.uniqueLookup(handle, encodedKey.dataStart, encodedKey.length);
        if (size == -2) return null;
        if (size < 0) throw new Error('Authentication history unavailable (status ' + size.toString() + ')');
        const encoded = new Uint8Array(size);
        if (toildbHost.takeResult(encoded.dataStart, size) != size) throw new Error('Authentication history read failed');
        const value = instantiate<V>(); value.decodeInto(encoded);
        return new DocumentSnapshot<V>(value, encoded);
    }
    public static releaseSnapshot<K, V>(handle: u32, key: K, observed: DocumentSnapshot<V>): void {
        const encodedKey = key.encode(), encoded = observed.encoded;
        const status = toildbHost.uniqueRelease(handle, encodedKey.dataStart, encodedKey.length,
            encoded.dataStart, encoded.length, 0);
        if (status < 0) throw new Error('Authentication history release failed (status ' + status.toString() + ')');
    }
    public static document<K, V>(collection: Documents<K, V>, key: K): V | null {
        const value = collection.get(key);
        if (value == null && Db.lastError() != DbError.None)
            throw new Error('Authentication state temporarily unavailable (status ' + (-1000 - <i32>Db.lastError()).toString() + ')');
        return value;
    }
    public static owner<K, V>(collection: Unique<K, V>, key: K): V | null {
        const value = collection.lookup(key);
        if (value == null && Db.lastError() != DbError.None)
            throw new Error('Authentication state temporarily unavailable (status ' + (-1000 - <i32>Db.lastError()).toString() + ')');
        return value;
    }
}

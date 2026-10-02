/** An unavailable security record must never be mistaken for an absent restriction. */
export class AuthReads {
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

import { AuthReads } from 'toiljs/server/auth/AuthReads';
import { DataReader } from 'data';
import { toildbHost } from 'bindings/toildb';
import { AuthStateDb, SessionUserKey, SessionEpochKey, SessionEpoch } from './AuthStateDb';
/** Immutable per-user generations fence sessions and in-flight login challenges without clock assumptions. */
export class SessionEpochs {
    private static key(userData: Uint8Array): string {
        const reader = new DataReader(userData);
        reader.readU32(); // @data message-boundary identifier
        const id = reader.readBytes();
        if (!reader.ok || id.length != 32) throw new Error('Invalid session identity');
        return crypto.toHex(id);
    }
    private static read(id: string): SessionEpoch {
        const key = new SessionUserKey(id);
        const head = AuthStateDb.epochHeads.getCurrentSnapshot(key);
        if (head == null && Db.lastError() != DbError.None)
            throw new Error('Session state unavailable');
        let epoch = head == null ? new SessionEpoch() : head.value;
        const revision = epoch.revision;
        // Leave room for authentication, application work and three revoke attempts.
        // Repair even a partial scan: retries then converge instead of locking a
        // user out forever when more than one chunk of claims lost their head write.
        for (let i: i32 = 0; i < 8; i++) {
            if (epoch.revision == u64.MAX_VALUE) throw new Error('Session generation exhausted');
            const next = AuthReads.owner(AuthStateDb.epochRevisions, new SessionEpochKey(id, epoch.revision + 1));
            if (next == null) {
                if (epoch.revision != revision && toildbHost.writeAllowed() == 1)
                    AuthStateDb.epochHeads.compareExchangeSnapshot(key, head, epoch);
                return epoch;
            }
            epoch = next;
        }
        // CAS prevents a delayed repair from overwriting a newer head. Query
        // verification is read-only; sign-in/revocation requests do the repair.
        if (toildbHost.writeAllowed() == 1)
            AuthStateDb.epochHeads.compareExchangeSnapshot(key, head, epoch);
        throw new Error('Session state recovering; retry');
    }
    public static current(userData: Uint8Array): u64 {
        return SessionEpochs.read(SessionEpochs.key(userData)).revision;
    }
    public static allowed(userData: Uint8Array, generation: u64): bool {
        return generation == SessionEpochs.current(userData);
    }
    public static revoke(userData: Uint8Array): void {
        SessionEpochs.revokeId(SessionEpochs.key(userData));
    }
    /** The stable 32-byte user id as hex; no request or @user encoder needed. */
    public static revokeId(id: string): void {
        if (id.length != 64) throw new Error('Invalid session identity');
        for (let i: i32 = 0; i < 3; i++) {
            const epoch = SessionEpochs.read(id);
            const next = new SessionEpoch();
            next.revision = epoch.revision + 1;
            if (!AuthStateDb.epochRevisions.claim(new SessionEpochKey(id, next.revision), next).claimed) continue;
            // The immutable claim is the revocation commit. A concurrent head
            // advance must not be undone by this request's delayed write.
            const key = new SessionUserKey(id);
            const head = AuthStateDb.epochHeads.getCurrentSnapshot(key);
            if (head == null && Db.lastError() != DbError.None)
                throw new Error('Session state unavailable');
            if (head == null || head.value.revision < next.revision)
                AuthStateDb.epochHeads.compareExchangeSnapshot(key, head, next);
            return;
        }
        throw new Error('Session revocation conflicted; retry');
    }
}

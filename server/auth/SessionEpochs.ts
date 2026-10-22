import { AuthRealm } from 'toiljs/server/auth/AuthRealm';
import { AuthReads } from 'toiljs/server/auth/AuthReads';
import { DataReader } from 'data';
import { toildbHost } from 'bindings/toildb';
import { AuthStateDb, SessionUserKey, SessionEpochKey, SessionEpoch } from 'toiljs/server/auth/AuthStateDb';
/** Immutable per-user generations fence sessions and in-flight login challenges without clock assumptions. */
export class SessionEpochs {
    public static key(userData: Uint8Array): string {
        const reader = new DataReader(userData);
        reader.readU32(); // @data message-boundary identifier
        const id = reader.readBytes();
        if (!reader.ok || id.length != 32) throw new Error('Invalid session identity');
        return crypto.toHex(id);
    }
    public static read(id: string, host: string = AuthRealm.current()): SessionEpoch {
        const key = new SessionUserKey('3:' + host + '\x00' + id);
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
            const next = AuthReads.owner(AuthStateDb.epochRevisions, new SessionEpochKey('3:' + host + '\x00' + id, epoch.revision + 1));
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
        return SessionEpochs.allowedId(SessionEpochs.key(userData), generation);
    }
    public static allowedId(id: string, generation: u64): bool {
        return generation == SessionEpochs.read(id).revision;
    }
    public static revoke(userData: Uint8Array): void {
        SessionEpochs.revokeId(SessionEpochs.key(userData));
    }
    /** Optimistic revocation after an @auth check. A competing advance falls back to a fresh scan. */
    public static revokeVerifiedId(id: string, verified: u64, state: SessionEpoch): void {
        if (id.length != 64) throw new Error('Invalid session identity');
        if (verified == u64.MAX_VALUE) throw new Error('No verified session generation');
        const next = SessionEpochs.successor(state);
        if (state.revision != verified) throw new Error('Invalid verified session state');
        if (AuthStateDb.epochRevisions.claim(new SessionEpochKey('3:' + AuthRealm.current() + '\x00' + id, next.revision), next).claimed) {
            // The immutable claim is authoritative. The next writable verification
            // repairs this one-revision head lag; queries can already see the claim.
            return;
        }
        // The cached generation became stale. Advance AFTER the security change,
        // including sessions minted under the competing generation.
        SessionEpochs.revokeId(id);
    }
    private static successor(epoch: SessionEpoch): SessionEpoch {
        if (epoch.revision == u64.MAX_VALUE) throw new Error('Session generation exhausted');
        const next = new SessionEpoch(); next.revision = epoch.revision + 1;
        next.claimNonce = new Uint8Array(16); crypto.getRandomValues(next.claimNonce);
        next.factorHost = epoch.factorHost; next.factorName = epoch.factorName;
        next.factorMethod = epoch.factorMethod; next.factorRevision = epoch.factorRevision;
        next.factorSecret = epoch.factorSecret;
        return next;
    }
    /** One unique claim commits the factor policy AND invalidates every earlier session. */
    public static changeFactor(id: string, verified: SessionEpoch, host: string, name: string,
        expected: u64, method: u8, secret: Uint8Array): bool {
        let epoch = verified;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (epoch.factorHost == host && epoch.factorName == name && epoch.factorRevision != expected) return false;
            if (expected == u64.MAX_VALUE) throw new Error('Factor revision exhausted');
            const next = SessionEpochs.successor(epoch);
            next.factorHost = host; next.factorName = name; next.factorMethod = method;
            next.factorRevision = expected + 1; next.factorSecret = secret;
            if (AuthStateDb.epochRevisions.claim(new SessionEpochKey('3:' + AuthRealm.current() + '\x00' + id, next.revision), next).claimed) return true;
            epoch = SessionEpochs.read(id);
        }
        throw new Error('Factor change conflicted; retry');
    }
    /** The stable 32-byte user id as hex; no request or @user encoder needed. */
    public static revokeId(id: string, host: string = AuthRealm.current()): void {
        if (id.length != 64) throw new Error('Invalid session identity');
        for (let i: i32 = 0; i < 3; i++) {
            const epoch = SessionEpochs.read(id, host);
            const next = SessionEpochs.successor(epoch);
            if (!AuthStateDb.epochRevisions.claim(new SessionEpochKey('3:' + host + '\x00' + id, next.revision), next).claimed) continue;
            // The immutable claim is the revocation commit. A concurrent head
            // advance must not be undone by this request's delayed write.
            const key = new SessionUserKey('3:' + host + '\x00' + id);
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

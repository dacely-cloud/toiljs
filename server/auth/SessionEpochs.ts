import { DataReader } from 'data';
@data
class SessionUserKey {
    id: string = '';
    constructor(id: string = '') { this.id = id; }
}
@data
class SessionEpochKey {
    id: string = '';
    revision: u64 = 0;
    constructor(id: string = '', revision: u64 = 0) { this.id = id; this.revision = revision; }
}
@data
class SessionEpoch {
    revision: u64 = 0;
}
@database
class SessionEpochDb {
    @collection static heads: Documents<SessionUserKey, SessionEpoch>;
    @collection static revisions: Unique<SessionEpochKey, SessionEpoch>;
}
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
        let epoch = SessionEpochDb.heads.get(new SessionUserKey(id));
        if (epoch == null) epoch = new SessionEpoch();
        for (let i: i32 = 0; i < 64; i++) {
            const next = SessionEpochDb.revisions.lookup(new SessionEpochKey(id, epoch.revision + 1));
            if (next == null) return epoch;
            epoch = next;
        }
        throw new Error('Session state unavailable');
    }
    public static current(userData: Uint8Array): u64 {
        return SessionEpochs.read(SessionEpochs.key(userData)).revision;
    }
    public static allowed(userData: Uint8Array, generation: u64): bool {
        return generation == SessionEpochs.current(userData);
    }
    public static revoke(userData: Uint8Array): void {
        const id = SessionEpochs.key(userData);
        for (let i: i32 = 0; i < 3; i++) {
            const epoch = SessionEpochs.read(id);
            epoch.revision += 1;
            if (!SessionEpochDb.revisions.claim(new SessionEpochKey(id, epoch.revision), epoch).claimed) continue;
            SessionEpochDb.heads.upsert(new SessionUserKey(id), epoch);
            return;
        }
        throw new Error('Session revocation conflicted; retry');
    }
}

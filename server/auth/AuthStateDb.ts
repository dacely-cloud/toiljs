@data
export class SessionUserKey {
    id: string = '';
    constructor(id: string = '') { this.id = id; }
}
@data
export class SessionEpochKey {
    id: string = '';
    revision: u64 = 0;
    constructor(id: string = '', revision: u64 = 0) { this.id = id; this.revision = revision; }
}
@data
export class SessionEpoch {
    revision: u64 = 0;
    claimNonce: Uint8Array = new Uint8Array(0);
    // Factor changes and session fencing share this immutable commit.
    // The account incarnation in factorName prevents inheritance after recreation.
    factorHost: string = '';
    factorName: string = '';
    factorMethod: u8 = 0;
    factorRevision: u64 = 0;
    factorSecret: Uint8Array = new Uint8Array(0);
    // Append-only deletion fence; retained across account recreation.
    factorFence: u64 = 0;
    deleting: bool = false;
    deletionGeneration: u64 = 0;
}
@data
export class FactorKey {
    host: string = '';
    username: string = '';
    constructor(host: string = '', username: string = '') { this.host = host; this.username = username; }
}
@data
export class FactorRevision {
    host: string = '';
    username: string = '';
    revision: u64 = 0;
    constructor(host: string = '', username: string = '', revision: u64 = 0) { this.host = host; this.username = username; this.revision = revision; }
}
@data
export class FactorSettings {
    method: u8 = 0;
    revision: u64 = 0;
    encryptedSecret: Uint8Array = new Uint8Array(0);
}
@data
export class TotpCounter {
    step: u64 = 0;
}
@data
export class SessionDigest {
    digest: string = '';
    constructor(digest: string = '') { this.digest = digest; }
}
@data
export class RevokedSession {
    revoked: bool = true;
}
/** Tenant-scoped security state; separate collections, one database namespace. */
@database
export class AuthStateDb {
    @collection static revokedSessions: Unique<SessionDigest, RevokedSession>;
    @collection static epochHeads: Documents<SessionUserKey, SessionEpoch>;
    @collection static epochRevisions: Unique<SessionEpochKey, SessionEpoch>;
    @collection static totpCounters: Documents<FactorKey, TotpCounter>;
    @collection static factorHeads: Documents<FactorKey, FactorSettings>;
    @collection static factorRevisions: Unique<FactorRevision, FactorSettings>;
}

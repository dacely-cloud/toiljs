@data
export class SessionDigest {
    digest: string = '';
    constructor(digest: string = '') { this.digest = digest; }
}
@data
export class RevokedSession {
    revoked: bool = true;
}
@database
export class SessionRevocations {
    @collection static sessions: Unique<SessionDigest, RevokedSession>;
}

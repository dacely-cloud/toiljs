// Every lookup KEY carries the tenant `host` (realm) as its FIRST field, so the
// physical key includes the domain and the SAME logical name/email/id addresses a
// DIFFERENT row per host (cross-domain isolation, on top of toildb's per-tenant
// scoping). `host` is populated from `realm(ctx)` at every call site.
@data
export class Username {
    host: string = '';
    name: string = '';
    constructor(host: string = '', name: string = '') {
        this.host = host;
        this.name = name;
    }
}

@data
export class EmailKey {
    host: string = '';
    email: string = '';
    constructor(host: string = '', email: string = '') {
        this.host = host;
        this.email = email;
    }
}

@data
export class EmailOwner {
    username: string = '';
    accountId: Uint8Array = new Uint8Array(0);
    constructor(username: string = '', accountId: Uint8Array = new Uint8Array(0)) {
        this.username = username;
        this.accountId = accountId;
    }
}

@data
export class TokenId {
    hash: Uint8Array = new Uint8Array(0);
    constructor(hash: Uint8Array = new Uint8Array(0)) {
        this.hash = hash;
    }
}

/** A one-time confirm/reset token record: which account it authorizes + its
 *  absolute expiry (unix secs). Consumed with `getDelete`. */
@data
export class TokenRec {
    username: string = '';
    exp: u64 = 0;
    accountId: Uint8Array = new Uint8Array(0);
}

@data
export class ChallengeId {
    host: string = '';
    cid: Uint8Array = new Uint8Array(0);
    constructor(host: string = '', cid: Uint8Array = new Uint8Array(0)) {
        this.host = host;
        this.cid = cid;
    }
}

@data
export class AuthAccount {
    // The original credential fields keep their byte positions; `email` +
    // `emailConfirmed` are APPENDED so this is a forward-compatible, append-only
    // @data change (an old row decodes with emailConfirmed=false, the strict/safe
    // default) rather than a breaking mid-struct reorder the deploy gate rejects.
    username: string = '';
    salt: Uint8Array = new Uint8Array(0);
    publicKey: Uint8Array = new Uint8Array(0);
    memKiB: u32 = 0;
    iterations: u32 = 0;
    parallelism: u32 = 0;
    email: string = '';
    emailConfirmed: bool = false;
    // APPENDED (append-only, forward-compatible like `email` above): the account's
    // second-factor method (see the TWOFA_* enum). An old row decodes as 0 =
    // TWOFA_NONE (2FA off), the safe default, so existing accounts stay logged in
    // by password alone until they opt in via /auth/2fa/setup.
    twoFactorMethod: u8 = 0;
    // Append-only: the STABLE ToilUserId, derived once at registration. Reset rotates
    // publicKey but leaves this, so the id is stable across a reset.
    toilUserId: Uint8Array = new Uint8Array(0);
    // Account incarnation: never reused, even when username/password are reused.
    accountId: Uint8Array = new Uint8Array(0);
    deleting: bool = false;
    registering: bool = false;
    legacyFactors: bool = false;
    googleSubject: string = '';
    googleIssuedAt: u64 = 0;
    googleNonces: string[] = new Array<string>();
}

@data
export class Challenge {
    cid: Uint8Array = new Uint8Array(0);
    username: string = '';
    nonce: Uint8Array = new Uint8Array(0);
    iat: u64 = 0;
    exp: u64 = 0;
    sessionEpoch: u64 = 0;
    sessionVersion: u8 = 0;
    accountId: Uint8Array = new Uint8Array(0);
}

/** The lookup key for a login 2FA challenge: 16 random bytes minted per login.
 *  Lives in its OWN collection (twoFaLogins), a SEPARATE NAMESPACE from
 *  confirm/reset TokenId, so a confirm/reset token can never resolve here. */
@data
export class TwoFaId {
    host: string = '';
    id: Uint8Array = new Uint8Array(0);
    constructor(host: string = '', id: Uint8Array = new Uint8Array(0)) {
        this.host = host;
        this.id = id;
    }
}

/**
 * A pending second-factor challenge (login OR setup). METHOD-AGNOSTIC lifecycle
 * fields (username / exp / attempts) plus the per-method `codeHash`; `method` is
 * which factor was delivered and `targetMethod` is used ONLY by the setup flow
 * (what to set `account.twoFactorMethod` to on success). Login challenges leave
 * `targetMethod` at 0. `codeHash = SHA-256(username || 0x00 || code)`; the
 * plaintext code is never stored.
 */
@data
export class TwoFaChallenge {
    username: string = '';
    method: u8 = 0;
    codeHash: Uint8Array = new Uint8Array(0);
    exp: u64 = 0;
    attempts: u32 = 0;
    targetMethod: u8 = 0;
    sessionEpoch: u64 = 0;
    sessionVersion: u8 = 0;
    settingsRevision: u64 = 0;
    encryptedSecret: Uint8Array = new Uint8Array(0);
    accountId: Uint8Array = new Uint8Array(0);
}

@data
export class DeletedAccountKey {
    host: string = '';
    incarnation: string = '';
    constructor(host: string = '', incarnation: string = '') {
        this.host = host;
        this.incarnation = incarnation;
    }
}

@data
export class DeletedAccountMarker {
    deleted: bool = true;
    epochCursor: u64 = 1;
    factorPhase: u8 = 0;
    factorCursor: u64 = 1;
    factorMax: u64 = 0;
    factorPrepared: bool = false;
    factorDiscovering: bool = false;
    factorsErased: bool = false;
}

@database
export class AuthDb {
    @collection static userAccounts: Documents<AuthUserKey, AuthUserAccounts>;
    @collection static accounts: Documents<Username, AuthAccount>;
    // Permanent opaque incarnation guards prevent a late replica/snapshot replay
    // of an old account row from enabling that deleted account again.
    @collection static deletedAccounts: Documents<DeletedAccountKey, DeletedAccountMarker>;
    @collection static emails: Documents<EmailKey, EmailOwner>; // email -> username (uniqueness index)
    @collection static challenges: Documents<ChallengeId, Challenge>;
    @collection static confirmTokens: Documents<TokenId, TokenRec>;
    @collection static resetTokens: Documents<TokenId, TokenRec>;
    // username -> its CURRENT outstanding confirm/reset token id, so minting a new
    // one can invalidate the previous: outstanding tokens stay bounded at one per
    // user per kind (O(users)), not one per request (unbounded storage-griefing).
    @collection static confirmTokenOf: Documents<Username, TokenId>;
    @collection static resetTokenOf: Documents<Username, TokenId>;
    // SECOND-FACTOR challenges live in their OWN collections, a namespace fully
    // disjoint from confirm/reset tokens (above). A reset/confirm token looked up
    // here finds nothing (wrong collection); a 2FA code/id looked up in the token
    // collections finds nothing. The separation is STRUCTURAL, not a purpose
    // string. `twoFaLogins` is keyed by a random per-login id; `twoFaSetup` is
    // keyed by username = one outstanding setup challenge per user.
    @collection static twoFaLogins: Documents<TwoFaId, TwoFaChallenge>;
    @collection static twoFaSetup: Documents<Username, TwoFaChallenge>;
}

@data
export class AuthUserKey {
    id: string = '';
    constructor(id: string = '') { this.id = id; }
}

@data
export class AuthUserAccount {
    host: string = '';
    username: string = '';
    accountId: Uint8Array = new Uint8Array(0);
    constructor(host: string = '', username: string = '', accountId: Uint8Array = new Uint8Array(0)) {
        this.host = host; this.username = username; this.accountId = accountId;
    }
}

@data
export class AuthUserAccounts {
    accounts: AuthUserAccount[] = new Array<AuthUserAccount>();
}

import { AuthDb, AuthAccount, Username, EmailKey, DeletedAccountKey, DeletedAccountMarker,
    AuthUserKey, AuthUserAccount, AuthUserAccounts } from './AuthStore';
import { AuthStateDb, SessionEpochKey, SessionEpoch, FactorKey, FactorRevision, FactorSettings } from './AuthStateDb';
import { AuthReads } from './AuthReads';
import { Authenticator } from './Authenticator';
import { __toildbResolve } from 'toildb';
import { base64UrlEncode } from 'toiljs/server/runtime';
import { SessionEpochs } from './SessionEpochs';

@lazy let epochHandle: u32 = u32.MAX_VALUE;
@lazy let factorHandle: u32 = u32.MAX_VALUE;
function epochHistoryHandle(): u32 {
    if (epochHandle == u32.MAX_VALUE) epochHandle = __toildbResolve('AuthStateDb/epochRevisions');
    return epochHandle;
}
function factorHistoryHandle(): u32 {
    if (factorHandle == u32.MAX_VALUE) factorHandle = __toildbResolve('AuthStateDb/factorRevisions');
    return factorHandle;
}

function sameBytes(a: Uint8Array, b: Uint8Array): bool {
    if (a.length != b.length) return false;
    let different: i32 = 0;
    for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
    return different == 0;
}

/** Shared request/daemon account lifecycle. Storage types keep their original
 * names and field order when moved out of the REST-only entry. */
export class AuthMaintenance {
    static incarnation(acct: AuthAccount): Uint8Array {
        return acct.accountId.length != 0 ? acct.accountId :
            crypto.sha256Text(crypto.toHex(acct.salt) + ':' + crypto.toHex(acct.publicKey));
    }
    static wasDeleted(host: string, acct: AuthAccount): bool {
        const marker = AuthDb.deletedAccounts.getCurrentSnapshot(new DeletedAccountKey(host, crypto.toHex(AuthMaintenance.incarnation(acct))));
        if (marker == null && Db.lastError() != DbError.None) throw new Error('Account deletion state temporarily unavailable');
        if (marker != null) return true;
        if (acct.accountId.length == 0 || acct.legacyFactors) {
            const legacy = AuthDb.deletedAccounts.getCurrentSnapshot(new DeletedAccountKey(host, 'legacy:' + crypto.toHex(crypto.sha256(acct.salt))));
            if (legacy == null && Db.lastError() != DbError.None) throw new Error('Account deletion state temporarily unavailable');
            return legacy != null;
        }
        return false;
    }
    static index(host: string, acct: AuthAccount): void {
        if (acct.toilUserId.length != 32) throw new Error('Invalid account identity');
        const key = new AuthUserKey(crypto.toHex(acct.toilUserId));
        const incarnation = AuthMaintenance.incarnation(acct);
        for (let attempt: i32 = 0; attempt < 4; attempt++) {
            const observed = AuthDb.userAccounts.getCurrentSnapshot(key);
            if (observed == null && Db.lastError() != DbError.None) throw new Error('Account index unavailable');
            const next = observed == null ? new AuthUserAccounts() : observed.value;
            let found = false;
            for (let i = 0; i < next.accounts.length; i++) {
                const owner = next.accounts[i];
                if (owner.host != host || owner.username != acct.username) continue;
                if (sameBytes(owner.accountId, incarnation)) return;
                // Replacing an index pointer needs proof that its incarnation
                // no longer owns the authoritative account row.
                const current = AuthDb.accounts.getCurrentSnapshot(new Username(host, acct.username));
                if (current == null && Db.lastError() != DbError.None) throw new Error('Account owner unavailable');
                if (current == null || !sameBytes(AuthMaintenance.incarnation(current.value), incarnation))
                    throw new Error('Account index changed; retry');
                next.accounts[i] = new AuthUserAccount(host, acct.username, incarnation);
                found = true;
            }
            if (!found) {
                if (next.accounts.length >= 16) throw new Error('Account identity has too many realms');
                next.accounts.push(new AuthUserAccount(host, acct.username, incarnation));
            }
            if (AuthDb.userAccounts.compareExchangeSnapshot(key, observed, next)) return;
        }
        throw new Error('Account index conflicted; retry');
    }
    static deleteUser(id: ToilUserId, realm: string): bool {
        const uid = id.toBytes();
        const index = AuthDb.userAccounts.getCurrentSnapshot(new AuthUserKey(crypto.toHex(uid)));
        if (index == null) {
            if (Db.lastError() != DbError.None) throw new Error('Account index unavailable');
            return false;
        }
        let selected: AuthUserAccount | null = null;
        for (let i = 0; i < index.value.accounts.length; i++) {
            const owner = index.value.accounts[i];
            if (realm.length != 0 && owner.host != realm) continue;
            if (selected != null) throw new Error('Ambiguous account realm; pass its normalized realm');
            selected = owner;
        }
        if (selected == null) return false;
        const key = new Username(selected.host, selected.username);
        let observed = AuthDb.accounts.getCurrentSnapshot(key);
        if (observed == null) {
            if (Db.lastError() != DbError.None) throw new Error('Account unavailable');
            AuthMaintenance.unindex(uid, selected.host, selected.username, selected.accountId);
            return false;
        }
        if (!sameBytes(observed.value.toilUserId, uid) ||
            !sameBytes(AuthMaintenance.incarnation(observed.value), selected.accountId)) {
            AuthMaintenance.unindex(uid, selected.host, selected.username, selected.accountId);
            return false;
        }
        if (!observed.value.deleting) {
            observed.value.deleting = true;
            if (!AuthDb.accounts.compareExchangeSnapshot(key, observed, observed.value)) throw new Error('Account changed; retry deletion');
            observed = new DocumentSnapshot<AuthAccount>(observed.value, observed.value.encode());
        }
        if (!AuthMaintenance.finishDeletion(key, observed, uid)) throw new Error('Account changed; retry deletion');
        return true;
    }
    private static unindex(uid: Uint8Array, host: string, username: string, incarnation: Uint8Array): void {
        const key = new AuthUserKey(crypto.toHex(uid));
        for (let attempt: i32 = 0; attempt < 4; attempt++) {
            const observed = AuthDb.userAccounts.getCurrentSnapshot(key);
            if (observed == null) {
                if (Db.lastError() != DbError.None) throw new Error('Account index unavailable');
                return;
            }
            const next = new AuthUserAccounts();
            for (let i = 0; i < observed.value.accounts.length; i++) {
                const owner = observed.value.accounts[i];
                if (owner.host != host || owner.username != username || !sameBytes(owner.accountId, incarnation)) next.accounts.push(owner);
            }
            if (next.accounts.length == observed.value.accounts.length) return;
            if (next.accounts.length == 0 ? AuthDb.userAccounts.compareDeleteSnapshot(key, observed) :
                AuthDb.userAccounts.compareExchangeSnapshot(key, observed, next)) return;
        }
        throw new Error('Account index cleanup conflicted; retry');
    }
    static indexUsers(limit: i32, cursor: Uint8Array | null): Uint8Array | null {
        if (limit < 1 || limit > 8) throw new Error('indexUsers limit must be 1..8');
        const page = AuthDb.accounts.scan(limit, cursor);
        for (let i = 0; i < page.entries.length; i++) {
            const entry = page.entries[i];
            const account = entry.value;
            if (account.deleting || account.registering || AuthMaintenance.wasDeleted(entry.key.host, account)) continue;
            if (account.toilUserId.length == 0) {
                const domain = Environment.getSecure('TOIL_AUTH_DOMAIN');
                if (domain == null || domain.length == 0) throw new Error('Legacy identity backfill requires the original TOIL_AUTH_DOMAIN');
                account.toilUserId = ToilUserId.derive(account.publicKey, account.username, domain).toBytes();
                if (!AuthDb.accounts.compareExchangeSnapshot(entry.key, entry.snapshot, account)) throw new Error('Account changed during backfill; retry this page');
            }
            AuthMaintenance.index(entry.key.host, account);
        }
        return page.cursor;
    }
    /** Bounded, restartable erasure. Only opaque progress and generation fences
     * survive; immutable epoch history must not retain old names or secrets. */
    private static eraseFactors(key: Username, acct: AuthAccount, uid: Uint8Array,
        markerKey: DeletedAccountKey): void {
        let marker = AuthDb.deletedAccounts.getCurrentSnapshot(markerKey);
        if (marker == null) throw new Error('Account deletion marker unavailable');
        if (marker.value.factorsErased) return;
        const epoch = SessionEpochs.beginDeletion(crypto.toHex(uid), key.host);
        const progress = marker.value;
        // Publish progress on any budget boundary. Replaying a partially erased
        // entry is safe: counters are deleted before the containing revision.
        let steps: i32 = 0;
        while (progress.epochCursor < epoch.revision) {
            const budget = Db.budget();
            if (budget.remainingOps < 28 || budget.remainingWrites < 20 || steps++ >= 128) {
                if (!AuthDb.deletedAccounts.compareExchangeSnapshot(markerKey, marker, progress))
                    throw new Error('Account cleanup conflicted; retry');
                throw new Error('Account cleanup incomplete; retry deletion');
            }
            const revisionKey = new SessionEpochKey('3:' + key.host + '\x00' + crypto.toHex(uid), progress.epochCursor);
            const previous = AuthReads.ownerSnapshot<SessionEpochKey, SessionEpoch>(epochHistoryHandle(), revisionKey);
            if (previous != null && previous.value.factorHost.length == 0 && previous.value.factorName.length == 0 &&
                previous.value.factorMethod == 0 && previous.value.factorRevision == 0 && previous.value.factorSecret.length == 0) {
                // Keep an existing anonymous owner occupied, including when a
                // concurrent cleanup still has an older progress snapshot.
                progress.epochCursor++;
                continue;
            }
            if (previous != null) {
                Authenticator.eraseCounter(previous.value.factorHost, previous.value.factorSecret);
                AuthReads.releaseSnapshot(epochHistoryHandle(), revisionKey, previous);
            }
            // Keep an anonymous owner at every old revision. A delayed claim
            // must not repopulate a released slot with an old sealed factor.
            const erased = new SessionEpoch();
            erased.revision = progress.epochCursor; erased.factorFence = epoch.factorFence;
            erased.deleting = true; erased.deletionGeneration = epoch.deletionGeneration;
            if (!AuthStateDb.epochRevisions.claim(revisionKey, erased).claimed)
                throw new Error('Factor history cleanup conflicted; retry deletion');
            progress.epochCursor++;
        }
        const currentName = acct.googleSubject.length != 0 ? 'google:' + base64UrlEncode(acct.accountId) :
            acct.accountId.length == 0 || acct.legacyFactors ? acct.username : acct.username + '\x00' + crypto.toHex(acct.accountId);
        while (progress.factorPhase < 2) {
            const name = progress.factorPhase == 0 ? currentName : acct.username;
            if (progress.factorPhase == 1 && name == currentName) { progress.factorPhase++; continue; }
            const factorKey = new FactorKey(key.host, name);
            if (!progress.factorPrepared) {
                if (!progress.factorDiscovering) {
                    const head = AuthStateDb.factorHeads.getCurrentSnapshot(factorKey);
                    if (head == null && Db.lastError() != DbError.None) throw new Error('Factor cleanup unavailable');
                    progress.factorMax = head == null ? 0 : head.value.revision;
                    progress.factorDiscovering = true;
                }
                // Discover unpublished legacy revisions in bounded slices too.
                while (true) {
                    const budget = Db.budget();
                    if (budget.remainingOps < 28 || budget.remainingWrites < 20 || steps++ >= 128) {
                        if (!AuthDb.deletedAccounts.compareExchangeSnapshot(markerKey, marker, progress))
                            throw new Error('Account cleanup conflicted; retry');
                        throw new Error('Account cleanup incomplete; retry deletion');
                    }
                    if (progress.factorMax == u64.MAX_VALUE) throw new Error('Factor revision exhausted');
                    const next = AuthReads.owner(AuthStateDb.factorRevisions,
                        new FactorRevision(key.host, name, progress.factorMax + 1));
                    if (next == null) break;
                    progress.factorMax++;
                }
                progress.factorPrepared = true;
                // Save the bound before deleting the head that supplied it.
                if (!AuthDb.deletedAccounts.compareExchangeSnapshot(markerKey, marker, progress))
                    throw new Error('Account cleanup conflicted; retry');
                marker = new DocumentSnapshot<DeletedAccountMarker>(progress, progress.encode());

            }
            const remainingHead = AuthStateDb.factorHeads.getCurrentSnapshot(factorKey);
            if (remainingHead == null && Db.lastError() != DbError.None) throw new Error('Factor cleanup unavailable');
            if (remainingHead != null) {
                Authenticator.eraseCounter(key.host, remainingHead.value.encryptedSecret);
                AuthStateDb.factorHeads.delete(factorKey);
            }
            while (progress.factorCursor <= progress.factorMax) {
                const budget = Db.budget();
                if (budget.remainingOps < 28 || budget.remainingWrites < 20 || steps++ >= 128) {
                    if (!AuthDb.deletedAccounts.compareExchangeSnapshot(markerKey, marker, progress))
                        throw new Error('Account cleanup conflicted; retry');
                    throw new Error('Account cleanup incomplete; retry deletion');
                }
                const revisionKey = new FactorRevision(key.host, name, progress.factorCursor);
                const previous = AuthReads.ownerSnapshot<FactorRevision, FactorSettings>(factorHistoryHandle(), revisionKey);
                if (previous != null) {
                    Authenticator.eraseCounter(key.host, previous.value.encryptedSecret);
                    AuthReads.releaseSnapshot(factorHistoryHandle(), revisionKey, previous);
                }
                progress.factorCursor++;
            }
            progress.factorPhase++; progress.factorPrepared = false; progress.factorDiscovering = false;
            progress.factorCursor = 1; progress.factorMax = 0;
        }
        progress.factorsErased = true;
        if (!AuthDb.deletedAccounts.compareExchangeSnapshot(markerKey, marker, progress))
            throw new Error('Account cleanup conflicted; retry');
    }
    static finishDeletion(key: Username, observed: DocumentSnapshot<AuthAccount>, uid: Uint8Array): bool {
        const acct = observed.value;
        if (!acct.deleting) return false;
        const deletedKey = new DeletedAccountKey(key.host, crypto.toHex(AuthMaintenance.incarnation(acct)));
        if (!AuthDb.deletedAccounts.compareExchange(deletedKey, null, new DeletedAccountMarker()) && !AuthMaintenance.wasDeleted(key.host, acct))
            throw new Error('Account deletion state temporarily unavailable');
        if (acct.accountId.length == 0 || acct.legacyFactors) {
            const legacyKey = new DeletedAccountKey(key.host, 'legacy:' + crypto.toHex(crypto.sha256(acct.salt)));
            if (!AuthDb.deletedAccounts.compareExchange(legacyKey, null, new DeletedAccountMarker())) {
                const legacy = AuthDb.deletedAccounts.getCurrentSnapshot(legacyKey);
                if (legacy == null) throw new Error('Legacy deletion state temporarily unavailable');
            }
        }
        AuthMaintenance.eraseFactors(key, acct, uid, deletedKey);
        const emailKey = new EmailKey(key.host, acct.email);
        const email = AuthDb.emails.getCurrentSnapshot(emailKey);
        if (email == null && Db.lastError() != DbError.None) throw new Error('Email index temporarily unavailable');
        if (email != null && email.value.username == acct.username &&
            (email.value.accountId.length == 0 || sameBytes(email.value.accountId, AuthMaintenance.incarnation(acct)))) {
            AuthDb.emails.compareDeleteSnapshot(emailKey, email);
        }
        const secondary = new Username(key.host, acct.username + '\x00' + crypto.toHex(AuthMaintenance.incarnation(acct)));
        const confirm = AuthDb.confirmTokenOf.getDelete(secondary);
        if (confirm == null && Db.lastError() != DbError.None) throw new Error('Confirmation token temporarily unavailable');
        if (confirm != null) AuthDb.confirmTokens.delete(confirm);
        const reset = AuthDb.resetTokenOf.getDelete(secondary);
        if (reset == null && Db.lastError() != DbError.None) throw new Error('Reset token temporarily unavailable');
        if (reset != null) AuthDb.resetTokens.delete(reset);
        const pendingFactor = AuthDb.twoFaSetup.getCurrentSnapshot(secondary);
        if (pendingFactor == null && Db.lastError() != DbError.None) throw new Error('Factor setup cleanup unavailable');
        if (pendingFactor != null) Authenticator.eraseCounter(key.host, pendingFactor.value.encryptedSecret);
        AuthDb.twoFaSetup.delete(secondary);
        // Pre-incarnation heads use the plain username. New accounts never use
        // these keys, so cleaning them cannot touch a later registration.
        const legacy = new Username(key.host, acct.username);
        const legacyConfirm = AuthDb.confirmTokenOf.getDelete(legacy);
        if (legacyConfirm == null && Db.lastError() != DbError.None) throw new Error('Confirmation token temporarily unavailable');
        if (legacyConfirm != null) AuthDb.confirmTokens.delete(legacyConfirm);
        const legacyReset = AuthDb.resetTokenOf.getDelete(legacy);
        if (legacyReset == null && Db.lastError() != DbError.None) throw new Error('Reset token temporarily unavailable');
        if (legacyReset != null) AuthDb.resetTokens.delete(legacyReset);
        const legacyFactor = AuthDb.twoFaSetup.getCurrentSnapshot(legacy);
        if (legacyFactor == null && Db.lastError() != DbError.None) throw new Error('Legacy factor cleanup unavailable');
        if (legacyFactor != null) Authenticator.eraseCounter(key.host, legacyFactor.value.encryptedSecret);
        AuthDb.twoFaSetup.delete(legacy);
        // Security epochs intentionally remain so copied cookies and in-flight
        // logins cannot become valid when the same identity signs up again.
        SessionEpochs.revokeId(crypto.toHex(uid), key.host);
        if (!AuthDb.accounts.compareDeleteSnapshot(key, observed)) return false;
        AuthMaintenance.unindex(uid, key.host, acct.username, AuthMaintenance.incarnation(acct));
        return true;
    }
}
AuthService.__installMaintenance(AuthMaintenance.deleteUser, AuthMaintenance.indexUsers);

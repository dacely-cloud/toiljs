import { AuthReads } from 'toiljs/server/auth/AuthReads';
import { AuthStateDb, FactorKey, FactorRevision, FactorSettings, SessionEpoch } from 'toiljs/server/auth/AuthStateDb';
export class FactorRepository {
    public static read(host: string, username: string, legacy: u8, epoch: SessionEpoch): FactorSettings {
        if (epoch.factorHost == host && epoch.factorName == username) {
            const settings = new FactorSettings();
            settings.method = epoch.factorMethod; settings.revision = epoch.factorRevision;
            settings.encryptedSecret = epoch.factorSecret;
            return settings;
        }
        // Read-only compatibility with security state written before atomic epoch commits.
        let settings = AuthReads.document(AuthStateDb.factorHeads, new FactorKey(host, username));
        if (settings == null) { settings = new FactorSettings(); settings.method = legacy; }
        for (let i: i32 = 0; i < 64; i++) {
            const next = AuthReads.owner(AuthStateDb.factorRevisions, new FactorRevision(host, username, settings.revision + 1));
            if (next == null) return settings;
            settings = next;
        }
        throw new Error('Two-factor settings unavailable');
    }
}

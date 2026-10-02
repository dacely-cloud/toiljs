import { AuthReads } from 'toiljs/server/auth/AuthReads';
import { AuthStateDb, FactorKey, FactorRevision, FactorSettings } from './AuthStateDb';
export class FactorRepository {
    public static read(host: string, username: string, legacy: u8): FactorSettings {
        let settings = AuthReads.document(AuthStateDb.factorHeads, new FactorKey(host, username));
        if (settings == null) { settings = new FactorSettings(); settings.method = legacy; }
        for (let i: i32 = 0; i < 64; i++) {
            const next = AuthReads.owner(AuthStateDb.factorRevisions, new FactorRevision(host, username, settings.revision + 1));
            if (next == null) return settings;
            settings = next;
        }
        throw new Error('Two-factor settings unavailable');
    }
    public static save(host: string, username: string, method: u8, expected: u64): bool {
        const settings = new FactorSettings(); settings.method = method; settings.revision = expected + 1;
        if (!AuthStateDb.factorRevisions.claim(new FactorRevision(host, username, settings.revision), settings).claimed) return false;
        AuthStateDb.factorHeads.upsert(new FactorKey(host, username), settings);
        return true;
    }
}

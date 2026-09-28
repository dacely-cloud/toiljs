@data
class FactorKey {
    host: string = '';
    username: string = '';
    constructor(host: string = '', username: string = '') { this.host = host; this.username = username; }
}
@data
class FactorRevision {
    host: string = '';
    username: string = '';
    revision: u64 = 0;
    constructor(host: string = '', username: string = '', revision: u64 = 0) { this.host = host; this.username = username; this.revision = revision; }
}
@data
export class FactorSettings {
    method: u8 = 0;
    revision: u64 = 0;
}
@database
class FactorDb {
    @collection static heads: Documents<FactorKey, FactorSettings>;
    @collection static revisions: Unique<FactorRevision, FactorSettings>;
}
export class FactorRepository {
    public static read(host: string, username: string, legacy: u8): FactorSettings {
        let settings = FactorDb.heads.get(new FactorKey(host, username));
        if (settings == null) { settings = new FactorSettings(); settings.method = legacy; }
        for (let i: i32 = 0; i < 64; i++) {
            const next = FactorDb.revisions.lookup(new FactorRevision(host, username, settings.revision + 1));
            if (next == null) return settings;
            settings = next;
        }
        throw new Error('Two-factor settings unavailable');
    }
    public static save(host: string, username: string, method: u8, expected: u64): bool {
        const settings = new FactorSettings(); settings.method = method; settings.revision = expected + 1;
        if (!FactorDb.revisions.claim(new FactorRevision(host, username, settings.revision), settings).claimed) return false;
        FactorDb.heads.upsert(new FactorKey(host, username), settings);
        return true;
    }
}

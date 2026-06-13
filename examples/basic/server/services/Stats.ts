import { store } from '../core/store';

/** Typed RPC service (transport still a TODO): reached as `Server.stats.playerCount()` on the client. */
@service
class Stats {
    /** Number of seeded players (the RPC transport is a TODO, so this throws on the client for now). */
    @remote
    public playerCount(): i32 {
        return store.size;
    }
}

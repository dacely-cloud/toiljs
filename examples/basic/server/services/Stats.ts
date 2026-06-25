import { store } from '../core/store';

/** Typed RPC service: reached as `Server.stats.playerCount()` on the client (POSTs /__toil_rpc). */
@service
class Stats {
    @remote
    public playerCount(): i32 {
        return store.size;
    }
}

import { store } from '../core/store';

/** Typed RPC service: reached as `Server.stats.playerCount()` on the client (POSTs /__toil_rpc). */
@service
class Stats {
    @remote
    public playerCount(): i32 {
        return store.size;
    }

    // @auth on a @remote: the RPC dispatcher must reject with 401 when there is no valid session,
    // exactly like an @auth @rest route (the guard is compiler-injected into __rpcDispatch).
    @remote
    @auth
    public secretCount(): i32 {
        return store.size;
    }
}

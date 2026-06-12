// A small REST demo: a players list + a leaderboard.
//
// IMPORTANT - the server runs with a FRESH WebAssembly instance per request, so linear memory
// (and any module-level state, like the `store` below) is reset on every request. It does NOT
// persist across requests. We seed a few players at module init so the read routes always have
// data; the write routes (create / addScore) take effect only for the current request's response.
// For real persistence, call out to a database or KV store from your handler.
//
// `@data` types are the wire model (shared by HTTP and RPC). `@rest` controllers expose HTTP
// routes; `@service`/`@remote` expose typed RPC. Building the server (toilscript --rpcModule)
// regenerates the typed client into shared/server.ts:
//   @rest    -> Server.REST.<controller>.<route>(args)  (a working fetch client)
//   @service -> Server.<service>.<method>()             (RPC, transport TODO)

import { Response, RouteContext } from 'toiljs/server/runtime';

/** A leaderboard player. The `u256` id shows native bignums riding the wire: it crosses
 *  JSON as four 64-bit limbs and lands on the client as one `bigint`. */
@data
class Player {
    id: u256 = u256.Zero;
    name: string = '';
    score: i64 = 0;
}

/** Request body for `POST /players` - the fields a client supplies to create a player. */
@data
class NewPlayer {
    name: string = '';
}

/** Request body for `POST /players/:id/score` - points to add to a player's score. */
@data
class ScoreDelta {
    points: i64 = 0;
}

/** A leaderboard page. A `@data` wrapper so the `Player[]` round-trips through the codec. */
@data
class Standings {
    players: Player[] = [];
}

// Re-seeded on EVERY request - module memory does not persist across requests (see the note at
// the top of the file). Swap this for a database/KV to keep data between requests.
const store = new Map<u64, Player>();
let nextId: u64 = 1;

function seed(name: string, score: i64): void {
    const p = new Player();
    p.id = u256.fromU64(nextId++);
    p.name = name;
    p.score = score;
    store.set(p.id.toU64(), p);
}
seed('Ada', 120);
seed('Linus', 95);
seed('Grace', 140);

/**
 * Players, mounted at `/players`. On the client:
 *   await Server.REST.players.get({ params: { id } })
 *   await Server.REST.players.create({ body: new NewPlayer('Bob') })
 *   await Server.REST.players.addScore({ params: { id }, body: new ScoreDelta(10n) })
 */
@rest('players')
class Players {
    /** `GET /players/:id` - returns a `Response` for full control: a real 404 for a missing id,
     *  a custom header, and the `@data` body serialized with `toJSON()`. (The toilscript editor
     *  plugin types the compiler-injected `toJSON()`, so this is clean; return the `@data` type
     *  directly, like the other routes, when you do not need that control.) */
    @get('/:id')
    public get(ctx: RouteContext): Response {
        const id = u64.parse(ctx.param('id'));
        if (!store.has(id)) return Response.notFound();
        const p = store.get(id);

        return Response.json(p.toJSON().toString()).setHeader('cache-control', 'no-store');
    }

    /** `POST /players` - build a player from the request body and return it with a fresh id.
     *  Note: it is NOT saved (memory resets next request); persist to a real store to keep it. */
    @post('/')
    public create(input: NewPlayer): Player {
        const p = new Player();
        p.id = u256.fromU64(nextId++);
        p.name = input.name;
        p.score = 0;
        store.set(p.id.toU64(), p);

        return p;
    }

    /** `POST /players/:id/score` - add `points` (from the body) to the seeded player named by
     *  `:id` and return it. The change applies to this response only (memory resets next request). */
    @post('/:id/score')
    public addScore(input: ScoreDelta, ctx: RouteContext): Player {
        const id = u64.parse(ctx.param('id'));
        if (!store.has(id)) return new Player();
        const p = store.get(id);
        p.score += input.points;

        return p;
    }
}

/**
 * The leaderboard, mounted at `/leaderboard`. On the client:
 *   const board = await Server.REST.leaderboard.top(); // typed Standings { players: Player[] }
 */
@rest('leaderboard')
class Leaderboard {
    /** `GET /leaderboard` - the seeded players, highest score first. */
    @get('/')
    public top(): Standings {
        const board = new Standings();
        const all = store.values();
        for (let i = 0; i < all.length; i++) board.players.push(all[i]);
        board.players.sort((a: Player, b: Player): i32 => (a.score < b.score ? 1 : a.score > b.score ? -1 : 0));
        return board;
    }
}

/** Typed RPC service (transport still a TODO): reached as `Server.stats.playerCount()` on the client. */
@service
class Stats {
    /** Number of seeded players (the RPC transport is a TODO, so this throws on the client for now). */
    @remote
    public playerCount(): i32 {
        return store.size;
    }
}

/** A free `@remote` function: `Server.ping(n)` on the client. */
@remote
function ping(n: i32): i32 {
    return n + 1;
}

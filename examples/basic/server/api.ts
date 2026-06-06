// A small but real server: an in-memory players + leaderboard API.
//
// `@data` types are the wire model (shared by HTTP and RPC). `@rest` controllers
// expose HTTP routes; `@service`/`@remote` expose typed RPC. Building the server
// (toilscript --rpcModule) regenerates the typed client into shared/server.ts:
//   @rest    -> Server.REST.<controller>.<route>(args)  (a working fetch client)
//   @service -> Server.<service>.<method>()             (RPC, transport TODO)
//
// State here is a module-level Map, so it persists across requests for the life of
// the instance (controllers are constructed per-request). Swap it for a real store later.

import { Response, RouteContext } from 'toiljs/server/runtime';

/** A leaderboard player. */
@data
class Player {
    id: u64 = 0;
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

// In-memory store (module-level: persists across requests, unlike per-request controllers).
const store = new Map<u64, Player>();
let nextId: u64 = 1;

/**
 * Player CRUD, mounted at `/players`. On the client:
 *   await Server.REST.players.create({ body: new NewPlayer('Ada') })
 *   await Server.REST.players.get({ params: { id } })
 *   await Server.REST.players.addScore({ params: { id }, body: new ScoreDelta(10n) })
 */
@rest('players')
class Players {
    /** `POST /players` - create a player from the request body; returns it with its new id. */
    @post('/')
    public create(input: NewPlayer): Player {
        const p = new Player();
        p.id = nextId++;
        p.name = input.name;
        p.score = 0;
        store.set(p.id, p);
        return p;
    }

    /** `GET /players/:id` - fetch one player by its path param, or 404. */
    @get('/:id')
    public get(ctx: RouteContext): Response {
        const id = U64.parseInt(ctx.param('id'));
        if (!store.has(id)) return Response.notFound();
        return Response.json(store.get(id).toJSON().toString());
    }

    /** `POST /players/:id/score` - add `points` (from the body) to the player named by `:id`. */
    @post('/:id/score')
    public addScore(input: ScoreDelta, ctx: RouteContext): Response {
        const id = U64.parseInt(ctx.param('id'));
        if (!store.has(id)) return Response.notFound();
        const p = store.get(id);
        p.score += input.points;
        return Response.json(p.toJSON().toString());
    }
}

/**
 * The leaderboard, mounted at `/leaderboard`. On the client:
 *   const board = await Server.REST.leaderboard.top(); // typed Standings { players: Player[] }
 */
@rest('leaderboard')
class Leaderboard {
    /** `GET /leaderboard` - every player, highest score first. */
    @get('/')
    public top(): Standings {
        const board = new Standings();
        const all = store.values();
        for (let i = 0; i < all.length; i++) board.players.push(all[i]);
        board.players.sort((a: Player, b: Player): i32 => (a.score < b.score ? 1 : a.score > b.score ? -1 : 0));
        return board;
    }
}

/** Typed RPC service (transport still a TODO): reached as `Server.admin.reset()` on the client. */
@service
class Admin {
    /** Wipe the in-memory store. */
    @remote
    public reset(): i32 {
        store.clear();
        nextId = 1;
        return 0;
    }
}

/** A free `@remote` function: `Server.ping(n)` on the client. */
@remote
function ping(n: i32): i32 {
    return n + 1;
}

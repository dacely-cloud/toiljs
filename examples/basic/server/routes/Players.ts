import { Response, RouteContext } from 'toiljs/server/runtime';

import { allocId, store } from '../core/store';
import { NewPlayer } from '../models/NewPlayer';
import { Player } from '../models/Player';
import { ScoreDelta } from '../models/ScoreDelta';

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
        p.id = u256.fromU64(allocId());
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

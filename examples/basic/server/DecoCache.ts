import { Response, RouteContext } from 'toiljs/server/runtime';

// @rest controller exercising the new compile-time @cache decorator.
@rest('deco')
class DecoCache {
    // edge-cache 5 min + browser Cache-Control max-age=60, via the decorator
    @get('/cached')
    @cache(5, 60)
    public cached(ctx: RouteContext): Response {
        return Response.json('{"deco":"cached"}');
    }

    // no @cache -> never cached
    @get('/plain')
    public plain(ctx: RouteContext): Response {
        return Response.json('{"deco":"plain"}');
    }
}

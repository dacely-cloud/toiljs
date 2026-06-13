import { Method, Request, Response, ToilHandler } from 'toiljs/server/runtime';

// Exercises the tenant-directed cache. Detection is via the host's
// `Toil-Cache` response header (MISS on first compute+store, HIT on reuse,
// DYNAMIC when not cached), so the body need not vary.
export class CacheHandler extends ToilHandler {
    public handle(req: Request): Response {
        if (req.method == Method.GET && req.path == '/cacheable') {
            // edge-cache 5 min + browser Cache-Control max-age=60
            return Response.json('{"cached":true}').cache(5, 60);
        }
        if (req.method == Method.GET && req.path == '/auth-ok') {
            // edge-cache even when the request carries auth (allowAuth)
            return Response.json('{"authok":true}').cache(5, 0, false, true);
        }
        if (req.method == Method.GET && req.path == '/uncacheable') {
            return Response.json('{"cached":false}');
        }
        if (req.method == Method.POST && req.path == '/echo') {
            // cache per (path, body): same body hits, different body misses
            return Response.bytes(req.body).cache(5);
        }
        return Response.notFound();
    }
}

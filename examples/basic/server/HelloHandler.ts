import { ToilHandler, Request, Response, Method, Rest } from 'toiljs/server/runtime';

export class HelloHandler extends ToilHandler {
    public handle(req: Request): Response {
        // Try the @rest controllers first (see api.ts). Rest.dispatch returns the
        // first matching route's Response, or null if nothing matched - then we fall
        // through to our own logic. REST composes; it never takes over handle().
        const hit = Rest.dispatch(req);
        if (hit != null) {
            return hit;
        }

        if (req.method != Method.GET && req.method != Method.HEAD) {
            return Response.empty(405).setHeader('allow', 'GET, HEAD');
        }
        if (req.path == '/') {
            return Response.text('hello from toiljs\n');
        }
        if (req.path == '/json') {
            return Response.json('{"hello":"toiljs"}\n');
        }
        if (req.path == '/echo') {
            return Response.text('you GET ' + req.path + '\n');
        }
        return Response.notFound();
    }
}

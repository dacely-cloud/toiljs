import { ToilHandler, Request, Response, Method } from 'toiljs/server/runtime';

export class HelloHandler extends ToilHandler {
    public handle(req: Request): Response {
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

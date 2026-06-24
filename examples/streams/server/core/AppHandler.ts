import { ToilHandler, Request, Response, Method } from 'toiljs/server/runtime';

/** Every request enters here. Add `@rest` controllers under routes/ as you grow. */
export class AppHandler extends ToilHandler {
    public handle(req: Request): Response {
        if (req.method != Method.GET && req.method != Method.HEAD) {
            return Response.empty(405).setHeader('allow', 'GET, HEAD');
        }
        if (req.path == '/api/hello') {
            return Response.text('hello from toiljs\n');
        }
        if (req.path == '/api/hash') {
            // `crypto` is a global (no import), synchronous Web Crypto.
            return Response.text(crypto.toHex(crypto.sha256Text(req.path)) + '\n');
        }
        // Yield page routes and assets to the client: under `toiljs dev`
        // this falls through to Vite so the app renders at /.
        return Response.unhandled();
    }
}

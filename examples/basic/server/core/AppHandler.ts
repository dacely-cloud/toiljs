import { Method, Request, Response, Rest, ToilHandler } from 'toiljs/server/runtime';

/**
 * The app's request handler: every request enters here. `@rest` controllers (see
 * `routes/`) are tried first via `Rest.dispatch`; whatever they do not claim falls
 * through to the hand-rolled demo endpoints below, then yields to the client.
 */
export class AppHandler extends ToilHandler {
    public handle(req: Request): Response {
        // Rest.dispatch returns the first matching route's Response, or null if nothing
        // matched - then we fall through to our own logic. REST composes; it never takes
        // over handle().
        const hit = Rest.dispatch(req);
        if (hit != null) {
            return hit;
        }

        if (req.method != Method.GET && req.method != Method.HEAD) {
            return Response.empty(405).setHeader('allow', 'GET, HEAD');
        }

        if (req.path == '/json') {
            return Response.json('{"hello":"toiljs"}\n');
        }

        if (req.path == '/echo') {
            return Response.text('you GET ' + req.path + '\n');
        }

        // Web Crypto demo. `crypto` is a global (no import), synchronous: the
        // same SubtleCrypto-style API the browser has, running in the server
        // wasm via metered host functions.
        if (req.path == '/api/hash') {
            const digest = crypto.sha256Text(req.path);
            return Response.json('{"sha256":"' + crypto.toHex(digest) + '"}\n');
        }

        if (req.path == '/api/uuid') {
            return Response.text(crypto.randomUUID() + '\n');
        }

        // Unhandled (not a plain notFound): tells the host this server has no
        // answer for the path, so it may serve it itself. Under `toiljs dev`
        // that falls through to Vite (client routes, assets).
        return Response.unhandled();
    }
}

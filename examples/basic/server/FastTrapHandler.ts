import { Request, Response, ToilHandler } from 'toiljs/server/runtime';

export class FastTrapHandler extends ToilHandler {
    public handle(req: Request): Response {
        unreachable();          // wasm `unreachable` -> instant trap, ~0 gas
        return Response.text('x');
    }
}

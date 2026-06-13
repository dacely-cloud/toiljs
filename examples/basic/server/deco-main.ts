import { Server } from 'toiljs/server/runtime';
import { revertOnError } from 'toiljs/server/runtime/abort/abort';
import { Request, Response, Rest, ToilHandler } from 'toiljs/server/runtime';
import './DecoCache';

class DecoHandler extends ToilHandler {
    public handle(req: Request): Response {
        const hit = Rest.dispatch(req);
        if (hit != null) return hit;
        return Response.notFound();
    }
}

Server.handler = () => { return new DecoHandler(); };
export * from 'toiljs/server/runtime/exports';
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}

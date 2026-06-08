/**
 * A drop-in handler for REST-only projects: dispatches to every `@rest`
 * controller and 404s on a miss. Wire it with
 * `Server.handler = () => new RestHandler()`. If you need custom logic, skip
 * this and call `Rest.dispatch(req)` from your own `ToilHandler` instead.
 */

import { Request } from '../request';
import { Response } from '../response';
import { ToilHandler } from '../handlers/ToilHandler';
import { Rest } from './Rest';

export class RestHandler extends ToilHandler {
    /** Dispatches to the registered `@rest` controllers; an unhandled-marked 404 when none match. */
    handle(req: Request): Response {
        const hit = Rest.dispatch(req);
        if (hit != null) return hit;
        return Response.unhandled();
    }
}

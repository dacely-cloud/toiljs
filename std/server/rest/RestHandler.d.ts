// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * A drop-in handler for REST-only projects: dispatches to every `@rest`
 * controller and 404s on a miss. Wire it with
 * `Server.handler = () => new RestHandler()`. If you need custom logic, skip
 * this and call `Rest.dispatch(req)` from your own `ToilHandler` instead.
 */
import { Request } from '../request';
import { Response } from '../response';
import { ToilHandler } from '../handlers/ToilHandler';
export declare class RestHandler extends ToilHandler {
    /** Dispatches to the registered `@rest` controllers; an unhandled-marked 404 when none match. */
    handle(req: Request): Response;
}

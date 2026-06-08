/**
 * Base class every toiljs server-side handler extends, analog to
 * btc-runtime's `OP_NET`. Override `handle(req)` to produce the
 * response. The framework calls `onRequestStarted` / `onRequestCompleted`
 * around every call so the user can hook for logging or metrics
 * without re-implementing `handle`.
 */

import { Request } from '../request';
import { Response } from '../response';

export class ToilHandler {
    /**
     * Override to declare your routes. The default implementation
     * returns an unhandled-marked 404 so a handler that hasn't been
     * wired up still produces a valid envelope, and the host knows it
     * may serve the path itself.
     */
    public handle(_req: Request): Response {
        return Response.unhandled();
    }

    /**
     * Called before each `handle` call. Empty by default; override
     * for per-request setup (logging, header reads, etc.).
     */
    public onRequestStarted(_req: Request): void {}

    /**
     * Called after each `handle` call returns (also when it throws,
     * after the runtime has converted the throw into a 500). Empty by
     * default.
     */
    public onRequestCompleted(_req: Request, _resp: Response): void {}
}

/**
 * Server: the runtime singleton.
 *
 * The user's `main.ts` assigns `Server.handler = () => new MyHandler()`.
 * The `handle(req_ofs, req_len)` wasm export in `runtime/exports`
 * calls that factory once per request.
 */

import { Potential } from '../lang/Potential';
import { ToilHandler } from '../handlers/ToilHandler';
import { Request } from '../request';

@final
export class ServerEnvironment {
    /**
     * The user-supplied handler factory. Assigned at module init by
     * the contract's `main.ts`. We use a factory rather than a
     * pre-built instance so the user gets fresh state per request
     * (the alternative would be threading reset logic through every
     * handler class).
     */
    public handler: () => ToilHandler = defaultHandler;

    /**
     * Cached handler instance for the current request. Cleared at the
     * end of every dispatch so the next request runs the factory
     * again. Exposed for tests; user code should not touch it.
     */
    public _current: Potential<ToilHandler> = null;

    /**
     * The request being dispatched right now. Set by `runtime/exports::handle`
     * immediately after decode and cleared in {@link resetCurrentHandler}, so an
     * ambient accessor like `AuthService.getUser()` can read the current
     * request's cookies with no argument. Strictly single-request lifetime (the
     * wasm processes one request per `handle` and memory resets between them);
     * never cache it across requests.
     */
    public currentRequest: Request | null = null;

    /**
     * Build (or reuse) the handler for this request. Called once per
     * dispatch from `runtime/exports::handle`.
     */
    public currentHandler(): ToilHandler {
        if (this._current == null) {
            this._current = this.handler();
        }
        return <ToilHandler>this._current;
    }

    /**
     * Drop the cached handler so the next request gets a fresh one.
     * Called at the tail of `runtime/exports::handle`.
     */
    public resetCurrentHandler(): void {
        this._current = null;
        this.currentRequest = null;
    }
}

/**
 * Default factory used until the user's `main.ts` assigns
 * `Server.handler`. Returns a base handler whose `handle` produces a
 * 404 — useful as a no-op state during early bring-up and as a
 * fallback if the user forgot to wire one up.
 */
function defaultHandler(): ToilHandler {
    return new ToilHandler();
}

export const Server: ServerEnvironment = new ServerEnvironment();

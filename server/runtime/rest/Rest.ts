/**
 * The auto-populated REST router. Every `@rest` controller self-registers a
 * dispatcher here at module init (compiler-injected); your handler calls
 * `Rest.dispatch(req)` to try them all. The first controller that matches the
 * method + path wins; `null` means no route matched (fall through to your own
 * logic / static files / 404).
 */

import { Request } from '../request';
import { Response } from '../response';

/** A controller dispatcher: returns a Response on a route hit, null on a miss. */
export type RouteFn = (req: Request) => Response | null;

export class RestRegistry {
    private fns: Array<RouteFn> = new Array<RouteFn>();

    /** Compiler-injected: registers a controller's dispatcher. Not for direct use. */
    register(fn: RouteFn): void {
        this.fns.push(fn);
    }

    /** Try every registered controller in registration order; first match wins. */
    dispatch(req: Request): Response | null {
        for (let i = 0; i < this.fns.length; i++) {
            const hit = this.fns[i](req);
            if (hit != null) return hit;
        }
        return null;
    }

    /** Number of registered controllers (diagnostics / tests). */
    get size(): i32 {
        return this.fns.length;
    }
}

/** The process-wide REST router singleton. */
export const Rest: RestRegistry = new RestRegistry();

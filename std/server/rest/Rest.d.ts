// Generated from server/runtime by scripts/gen-server-types.mjs.
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
export declare class RestRegistry {
    private fns;
    /** Compiler-injected: registers a controller's dispatcher. Not for direct use. */
    register(fn: RouteFn): void;
    /** Try every registered controller in registration order; first match wins. */
    dispatch(req: Request): Response | null;
    /** Number of registered controllers (diagnostics / tests). */
    get size(): i32;
}
/** The process-wide REST router singleton. */
export declare const Rest: RestRegistry;

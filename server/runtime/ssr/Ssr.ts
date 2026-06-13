/**
 * The auto-populated SSR render router. Every compiler-generated route render
 * self-registers here at module init; the `render` wasm export calls
 * `Ssr.dispatch(req)` to find the one whose path matches. The host has already
 * decided this is a template route, but the guest re-derives WHICH route from
 * the request path (the template name is not in the request envelope), exactly
 * as a `@rest` controller matches its own prefix.
 *
 * First matching render wins; `null` means no route matched (a guest/host
 * coherence problem) and the export emits a fail-safe empty result.
 */

import { Request } from '../request';
import { SlotValues } from './slots';

/** A route render: returns filled hole values on a path hit, null on a miss. */
export type RenderFn = (req: Request) => SlotValues | null;

export class SsrRegistry {
    private fns: Array<RenderFn> = new Array<RenderFn>();

    /** Compiler-injected: registers a route's render. Not for direct use. */
    register(fn: RenderFn): void {
        this.fns.push(fn);
    }

    /** Try every registered render in registration order; first match wins. */
    dispatch(req: Request): SlotValues | null {
        for (let i = 0; i < this.fns.length; i++) {
            const hit = this.fns[i](req);
            if (hit != null) return hit;
        }
        return null;
    }

    /** Number of registered renders (diagnostics / tests). */
    get size(): i32 {
        return this.fns.length;
    }
}

/** The process-wide SSR render router singleton. */
export const Ssr: SsrRegistry = new SsrRegistry();

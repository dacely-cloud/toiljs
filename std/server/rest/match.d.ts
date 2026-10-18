// Generated from server/runtime by scripts/gen-server-types.mjs.
/**
 * Compile-time route patterns (`/api/todos/:id`) matched against a request path
 * at runtime, capturing `:params`. The compiler emits one `matchRoute(...)` call
 * per route inside a controller's injected `__tryRoute`.
 */
import { Request } from '../request';
import { RouteContext } from './RouteContext';
/**
 * Match `pattern` against `req.path`. Static segments must be equal; a `:name`
 * segment captures the corresponding path segment. The query string is ignored
 * for matching. Returns a populated `RouteContext` on a match, `null` on a miss.
 */
export declare function matchRoute(pattern: string, req: Request): RouteContext | null;

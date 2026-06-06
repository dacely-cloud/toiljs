/**
 * Compile-time route patterns (`/api/todos/:id`) matched against a request path
 * at runtime, capturing `:params`. The compiler emits one `matchRoute(...)` call
 * per route inside a controller's injected `__tryRoute`.
 */

import { Request } from '../request';
import { RouteContext } from './RouteContext';

const COLON: i32 = 0x3a; // ':'

/**
 * Match `pattern` against `req.path`. Static segments must be equal; a `:name`
 * segment captures the corresponding path segment. The query string is ignored
 * for matching. Returns a populated `RouteContext` on a match, `null` on a miss.
 */
export function matchRoute(pattern: string, req: Request): RouteContext | null {
    let path = req.path;
    const q = path.indexOf('?');
    if (q >= 0) path = path.substring(0, q);

    const pat = splitSegments(pattern);
    const act = splitSegments(path);
    if (pat.length != act.length) return null;

    const keys = new Array<string>();
    const vals = new Array<string>();
    for (let i = 0; i < pat.length; i++) {
        const seg = pat[i];
        if (seg.length > 0 && seg.charCodeAt(0) == COLON) {
            keys.push(seg.substring(1));
            vals.push(act[i]);
        } else if (seg != act[i]) {
            return null;
        }
    }
    return new RouteContext(req, keys, vals);
}

/** Split a path on `/`, dropping empty segments (so leading/trailing slashes don't matter). */
function splitSegments(path: string): Array<string> {
    const out = new Array<string>();
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].length > 0) out.push(parts[i]);
    }
    return out;
}
